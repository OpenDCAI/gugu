import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';

function page() {
  let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    sendCommand: vi.fn(async (_method: string, _params?: object, _session?: string): Promise<unknown> => ({ ok: true })),
  });
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    close: vi.fn(), loadURL: vi.fn(), focus: vi.fn(),
  });
  return {
    contents: contents as unknown as WebContents, debuggerApi,
    destroy: () => { destroyed = true; contents.emit('destroyed'); },
  };
}

describe('host-selected page protocol lease', () => {
  it('uses only the selected native page after its viewport is ready, preserving navigation and focus', async () => {
    const first = page(), other = page();
    let ready!: () => void;
    const lease = createPageProtocol(first.contents, { ready: new Promise(done => { ready = done; }) });
    const command = lease.send('Runtime.evaluate', { expression: 'document.title' });
    await new Promise(done => setImmediate(done));
    expect(first.debuggerApi.attach).not.toHaveBeenCalled();
    ready();
    await command;
    expect(first.debuggerApi.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: 'document.title' }, undefined);
    expect(other.debuggerApi.attach).not.toHaveBeenCalled();
    lease.close();
    expect(first.debuggerApi.detach).toHaveBeenCalledOnce();
    expect(first.contents.close).not.toHaveBeenCalled();
    expect(first.contents.loadURL).not.toHaveBeenCalled();
    expect(first.contents.focus).not.toHaveBeenCalled();
  });

  it.each([
    ['Browser.close', {}], ['Browser.getVersion', {}], ['SystemInfo.getInfo', {}],
    ['Target.getTargets', {}], ['Target.attachToTarget', { targetId: 'other' }],
    ['Target.getTargetInfo', { targetId: 'other' }], ['Target.closeTarget', { targetId: 'other' }],
    ['Target.sendMessageToTarget', { sessionId: 'other', message: '{}' }],
    ['Target.detachFromTarget', { sessionId: 'other' }], ['Target.setAutoAttach', { flatten: false }],
    ['Page.close', {}],
  ])('refuses %s before touching the debugger', async (method, params) => {
    const current = page(), lease = createPageProtocol(current.contents);
    await expect(lease.send(method, params)).rejects.toThrow('not available');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('accepts only child sessions announced by this page and forgets detached descendants', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    current.debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', {}, 'foreign');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'stolen' }, 'foreign');
    expect(heard).not.toHaveBeenCalled();
    await expect(lease.send('Runtime.evaluate', {}, 'stolen')).rejects.toThrow('unknown page session');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' });
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'grandchild' }, 'child');
    await lease.send('Runtime.evaluate', {}, 'grandchild');
    expect(current.debuggerApi.sendCommand).toHaveBeenLastCalledWith('Runtime.evaluate', {}, 'grandchild');
    current.debuggerApi.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'child' });
    await expect(lease.send('Runtime.evaluate', {}, 'grandchild')).rejects.toThrow('unknown page session');
    lease.close();
  });

  it('cancels commands still waiting for a viewport without attaching or closing the page', async () => {
    const current = page(), controller = new AbortController();
    const lease = createPageProtocol(current.contents, { signal: controller.signal, ready: new Promise(() => {}) });
    const result = expect(lease.send('Input.insertText', { text: 'never sent' })).rejects.toThrow('cancelled');
    controller.abort();
    await result;
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(current.contents.close).not.toHaveBeenCalled();
  });

  it('releases an in-flight caller on cancellation and never replays an uncertain native command', async () => {
    const current = page(), controller = new AbortController(), closed = vi.fn();
    let complete!: () => void;
    current.debuggerApi.sendCommand.mockImplementationOnce(() => new Promise(done => { complete = () => done({ late: true }); }));
    const lease = createPageProtocol(current.contents, { signal: controller.signal });
    lease.onClose(closed);
    const pending = lease.send('Input.insertText', { text: 'once' });
    const result = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce());
    controller.abort();
    await result;
    complete();
    await expect(lease.send('Input.insertText', { text: 'again' })).rejects.toThrow('cancelled');
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce();
    expect(current.debuggerApi.detach).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('borrows captures from the native rendering owner', async () => {
    const current = page(), capture = vi.fn(async () => ({ data: 'frame' }));
    const lease = createPageProtocol(current.contents, { capture });
    const params = { format: 'png', clip: { x: 2, y: 3, width: 10, height: 20, scale: 1 } };
    await expect(lease.send('Page.captureScreenshot', params)).resolves.toEqual({ data: 'frame' });
    expect(capture).toHaveBeenCalledWith(params);
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('does not steal or detach another debugger owner', async () => {
    const current = page();
    current.debuggerApi.attach();
    const lease = createPageProtocol(current.contents);
    await expect(lease.send('Runtime.enable')).rejects.toThrow('already in use');
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('settles in-flight commands on native destruction without touching the destroyed debugger', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    current.debuggerApi.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(lease.send('Runtime.enable')).rejects.toThrow('tab was closed');
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce());
    current.destroy();
    await pending;
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
    expect(current.debuggerApi.listenerCount('message')).toBe(0);
    expect(current.debuggerApi.listenerCount('detach')).toBe(0);
  });
});
