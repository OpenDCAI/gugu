import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBrowserPage, BrowserPageRuntime } from './browser-page-runtime';

function surface() {
  let destroyed = false;
  const image = { isEmpty: () => false };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => destroyed),
    loadURL: vi.fn(async (_url: string) => {}),
    capturePage: vi.fn(async () => image),
    setBackgroundThrottling: vi.fn(),
    beginFrameSubscription: vi.fn((_dirty: boolean, callback: (frame: { isEmpty: () => boolean }) => void) => { queueMicrotask(() => callback(image)); }),
    endFrameSubscription: vi.fn(),
    debugger: { sendCommand: vi.fn(async (_method: string, _params: object) => ({ data: 'captured' })) },
    close: vi.fn(() => {
      destroyed = true;
      // Electron clears the view getter before the debugger's detach/destruction notifications.
      view.webContents = undefined as never;
      contents.emit('detach');
      contents.emit('destroyed');
    }),
    stop: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(),
  });
  const view = { webContents: contents, setBounds: vi.fn(), setVisible: vi.fn() };
  const unused = vi.fn();
  const runtime = new BrowserPageRuntime(view as unknown as WebContentsView, unused);
  const host = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  runtime.moveTo(host as unknown as BrowserWindow);
  return { contents, view, runtime, unused, host };
}

afterEach(() => vi.useRealTimers());

describe('browser page runtime', () => {
  it('prepares the native viewport before loading the destination without a bootstrap navigation', async () => {
    const { contents, runtime, view, host } = surface();
    runtime.moveTo(null);
    const navigation = runtime.navigate('https://destination.test/');
    await new Promise(done => setImmediate(done));
    expect(contents.loadURL).not.toHaveBeenCalled();
    runtime.moveTo(host as unknown as BrowserWindow);
    await navigation;
    expect(contents.loadURL.mock.calls).toEqual([['https://destination.test/']]);
    expect(view.setVisible.mock.calls.slice(-2)).toEqual([[true], [false]]);
    expect(view.setVisible.mock.invocationCallOrder.at(-1)).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]);
    expect(contents.capturePage).not.toHaveBeenCalled();
    runtime.close();
  });

  it('supersedes a destination changed during startup, and stop cancels pending navigation', async () => {
    const first = surface();
    await Promise.all([first.runtime.navigate('https://old.test/'), first.runtime.navigate('https://new.test/')]);
    expect(first.contents.loadURL.mock.calls).toEqual([['https://new.test/']]);
    first.runtime.close();
    const second = surface();
    const pending = second.runtime.navigate('https://stopped.test/');
    second.runtime.stop();
    await pending;
    expect(second.contents.loadURL).not.toHaveBeenCalled();
    second.runtime.close();
  });

  it('has no image subscription while an agent is driving; captures subscribe only until the image is returned', async () => {
    const { contents, runtime } = surface();
    const lease = runtime.acquire();
    lease.setActive(true);
    await lease.ready;
    expect(contents.beginFrameSubscription).not.toHaveBeenCalled();
    const params = { format: 'png', clip: { x: 10, y: 20, width: 100, height: 200, scale: 0.5 }, captureBeyondViewport: true };
    await expect(lease.capture(params)).resolves.toEqual({ data: 'captured' });
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', params);
    expect(contents.beginFrameSubscription).toHaveBeenCalledOnce();
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce();
    lease.dispose();
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    runtime.close();
  });

  it('serializes UI and agent captures so one request cannot unsubscribe another', async () => {
    const { contents, runtime } = surface();
    const lease = runtime.acquire();
    await lease.ready;
    let resolve!: () => void;
    contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(done => { resolve = () => done({ data: 'one' }); }));
    const first = lease.capture({ format: 'png' });
    const second = runtime.snapshot();
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledOnce());
    expect(contents.beginFrameSubscription).toHaveBeenCalledOnce();
    resolve();
    await Promise.all([first, second]);
    expect(contents.beginFrameSubscription).toHaveBeenCalledTimes(2);
    expect(contents.endFrameSubscription).toHaveBeenCalledTimes(2);
    lease.dispose();
    runtime.close();
  });

  it('owns a stable contents reference when native destruction clears view.webContents', async () => {
    const { contents, runtime, unused } = surface();
    const lease = runtime.acquire();
    lease.setActive(true);
    await lease.ready;
    contents.on('detach', () => lease.dispose());
    expect(() => contents.close()).not.toThrow();
    expect(() => lease.dispose()).not.toThrow();
    expect(acquireBrowserPage(contents as never)).toBeUndefined();
    expect(unused).toHaveBeenCalledOnce();
  });

  it('aborts a capture and queued requests before closing native contents', async () => {
    const { contents, runtime } = surface();
    const lease = runtime.acquire();
    await lease.ready;
    contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
    const first = lease.capture({}), second = runtime.snapshot();
    const failed = Promise.all([expect(first).rejects.toThrow('closed'), expect(second).rejects.toThrow('closed')]);
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledOnce());
    runtime.close();
    await failed;
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce();
    expect(contents.endFrameSubscription.mock.invocationCallOrder[0]).toBeLessThan(contents.close.mock.invocationCallOrder[0]);
    lease.dispose();
  });

  it("cancels the disconnecting consumer's running and queued captures while preserving the page", async () => {
    const { contents, runtime } = surface();
    const lease = runtime.acquire();
    await lease.ready;
    contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
    const one = lease.capture({}), two = lease.capture({});
    const failed = Promise.all([expect(one).rejects.toThrow('connection was closed'), expect(two).rejects.toThrow('connection was closed')]);
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledOnce());
    lease.dispose();
    await failed;
    await Promise.resolve();
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce();
    expect(contents.close).not.toHaveBeenCalled();
    runtime.close();
  });

  it('times out frame readiness, releases its capture resources, and reports the failure', async () => {
    const { contents, runtime } = surface();
    const lease = runtime.acquire();
    await lease.ready;
    contents.beginFrameSubscription.mockImplementationOnce(() => {});
    vi.useFakeTimers();
    const pending = lease.capture({});
    const failed = expect(pending).rejects.toThrow('did not produce a frame');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce();
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    lease.dispose();runtime.close();
  });

  it('allows an explicit retry after startup fails, and disposed leases cannot capture', async () => {
    const { contents, runtime, view } = surface();
    view.setVisible.mockImplementationOnce(() => { throw new Error('surface unavailable'); });
    await expect(runtime.navigate('https://destination.test/')).rejects.toThrow('surface unavailable');
    expect(runtime.failed).toBe(true);
    await runtime.reload();
    expect(contents.loadURL).toHaveBeenLastCalledWith('https://destination.test/');
    const lease = runtime.acquire();
    await lease.ready;
    lease.dispose();
    await expect(lease.capture({})).rejects.toThrow('connection was closed');
    runtime.close();
  });

  it('pins the page for connected consumers until the last one releases it', async () => {
    const { runtime, unused } = surface();
    const first = runtime.acquire(), second = runtime.acquire();
    await Promise.all([first.ready, second.ready]);
    first.dispose();
    expect(runtime.inUse).toBe(true);
    expect(unused).not.toHaveBeenCalled();
    second.dispose();
    expect(runtime.inUse).toBe(false);
    expect(unused).toHaveBeenCalledOnce();
    runtime.close();
  });

  it('waits for a new host during window migration without starting an ownerless native capture', async () => {
    const { contents, runtime, host } = surface();
    await runtime.ready;
    runtime.moveTo(null);
    const capture = runtime.snapshot();
    await new Promise(done => setImmediate(done));
    expect(contents.beginFrameSubscription).not.toHaveBeenCalled();
    runtime.moveTo(host as unknown as BrowserWindow);
    await capture;
    expect(contents.beginFrameSubscription).toHaveBeenCalledOnce();
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce();
    runtime.close();
  });
});
