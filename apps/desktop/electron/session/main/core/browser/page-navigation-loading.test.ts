import { describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { page } from './test-support/page-protocol-fixture';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const loadingPage = () => {
  const current = page();
  vi.mocked(current.contents.isLoading).mockReturnValue(true);
  current.contents.emit('did-start-navigation', { url: 'file:///private/pending', isMainFrame: true });
  return current;
};

describe('page lease navigation loading boundary', () => {
  it('attaches immediately during an HTTP navigation with unfinished resources', async () => {
    const current = page();
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
    current.contents.emit('did-start-navigation', { url: 'https://example.test/slow', isMainFrame: true });
    const lease = createPageProtocol(current.contents);
    const pending = lease.send('Runtime.enable').catch(() => undefined);
    try {
      await tick();
      expect(current.debuggerApi.attach).toHaveBeenCalledOnce();
      expect(current.contents.isLoading()).toBe(true);
    } finally { lease.close(); await pending; }
  });

  it('does not expose an unsupported early frame navigation event', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Runtime.enable');
    current.debuggerApi.emit('message', {}, 'Page.frameStartedNavigating', { frameId: 'main', url: 'file:///private/secret' });
    expect(heard).not.toHaveBeenCalled();
    lease.close();
  });

  it('tracks a redirect that happened before the lease and releases all observers when the page is destroyed', async () => {
    const current = page();
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
    current.contents.emit('did-start-navigation', { url: 'https://example.test/redirect', isMainFrame: true });
    current.contents.emit('did-redirect-navigation', {}, 'file:///private/secret', false, true);
    const lease = createPageProtocol(current.contents);
    const pending = lease.send('Runtime.enable').then(() => 'opened', () => 'rejected');
    await tick();
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    current.destroy();
    expect(await pending).toBe('rejected');
    for (const event of ['did-start-navigation', 'did-redirect-navigation', 'did-navigate', 'did-stop-loading']) {
      expect(current.contents.listenerCount(event)).toBe(0);
    }
  });

  it('continues tracking navigation after a lease is released', async () => {
    const current = page(), first = createPageProtocol(current.contents);
    await first.send('Runtime.enable');
    first.close();
    current.debuggerApi.attach.mockClear();
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
    current.contents.emit('did-start-navigation', { url: 'file:///private/pending', isMainFrame: true });
    const second = createPageProtocol(current.contents);
    const pending = second.send('Runtime.enable').then(() => 'opened', () => 'rejected');
    await tick();
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    second.close();
    expect(await pending).toBe('rejected');
    current.destroy();
  });

  it('revokes an attached lease when an HTTP navigation redirects to a file', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Runtime.enable');
    current.contents.emit('did-redirect-navigation', {}, 'file:///private/secret', false, true);
    expect(lease.attached).toBe(false);
    await expect(lease.send('Runtime.evaluate')).rejects.toThrow('unsupported navigation');
    current.destroy();
  });

  it('waits for an already-started navigation and rejects a file commit without attaching or forwarding events', async () => {
    const current = loadingPage(), heard = vi.fn(), lease = createPageProtocol(current.contents);
    lease.onMessage(heard);
    const pending = lease.send('Runtime.enable').then(() => 'opened', () => 'rejected');
    await tick();
    const attachedDuringLoad = current.debuggerApi.attach.mock.calls.length;
    vi.mocked(current.contents.getURL).mockReturnValue('file:///private/secret');
    current.contents.emit('did-navigate', {}, 'file:///private/secret');
    current.debuggerApi.emit('message', {}, 'Runtime.bindingCalled', { payload: 'secret' });
    vi.mocked(current.contents.isLoading).mockReturnValue(false);
    current.contents.emit('did-stop-loading');
    expect(await pending).toBe('rejected');
    expect(attachedDuringLoad).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    expect(current.contents.listenerCount('did-stop-loading')).toBe(1);
    lease.close();
  });

  it('cancels one caller while loading while preserving another caller and the connection', async () => {
    const current = loadingPage(), controller = new AbortController(), lease = createPageProtocol(current.contents);
    const a = lease.send('Runtime.enable', { caller: 'a' }, undefined, controller.signal).then(() => 'opened', () => 'cancelled');
    const b = lease.send('Runtime.enable', { caller: 'b' });
    await tick();
    controller.abort();
    await tick();
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(await a).toBe('cancelled');
    vi.mocked(current.contents.isLoading).mockReturnValue(false);
    current.contents.emit('did-stop-loading');
    await b;
    expect(current.debuggerApi.sendCommand.mock.calls).toEqual([['Runtime.enable', { caller: 'b' }, undefined]]);
    lease.close();
  });

  it('revokes on a main-frame commit even when the start event was missed and the URL getter is stale', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Runtime.enable');
    current.contents.emit('did-navigate', {}, 'file:///private/secret');
    current.debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', { args: [{ value: 'secret' }] });
    expect(heard).not.toHaveBeenCalled();
    expect(lease.attached).toBe(false);
    lease.close();
  });

  it('checks the committed URL before forwarding binding and console events even without navigation callbacks', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Runtime.enable');
    vi.mocked(current.contents.getURL).mockReturnValue('file:///private/secret');
    for (const method of ['Runtime.bindingCalled', 'Runtime.consoleAPICalled']) current.debuggerApi.emit('message', {}, method, { payload: 'secret' });
    expect(heard).not.toHaveBeenCalled();
    expect(lease.attached).toBe(false);
    lease.close();
  });

  it('rechecks the committed URL on every send even without navigation callbacks', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Runtime.enable');
    current.debuggerApi.sendCommand.mockClear();
    vi.mocked(current.contents.getURL).mockReturnValue('file:///private/secret');
    await expect(lease.send('Runtime.evaluate', { expression: 'document.body.innerText' })).rejects.toThrow('navigation');
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('rechecks debugger ownership after the navigation finishes', async () => {
    const current = loadingPage(), lease = createPageProtocol(current.contents);
    const pending = lease.send('Runtime.enable').then(() => 'opened', () => 'refused');
    await tick();
    current.debuggerApi.attach();
    vi.mocked(current.contents.isLoading).mockReturnValue(false);
    current.contents.emit('did-stop-loading');
    expect(await pending).toBe('refused');
    expect(current.debuggerApi.attach).toHaveBeenCalledOnce();
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('bounds a navigation that never stops loading and releases its listener', async () => {
    vi.useFakeTimers();
    const current = loadingPage(), lease = createPageProtocol(current.contents);
    let outcome = 'pending';
    void lease.send('Runtime.enable').then(() => { outcome = 'opened'; }, () => { outcome = 'rejected'; });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe('rejected');
      expect(current.contents.listenerCount('did-stop-loading')).toBe(1);
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    } finally { lease.close(); vi.useRealTimers(); }
  });
});
