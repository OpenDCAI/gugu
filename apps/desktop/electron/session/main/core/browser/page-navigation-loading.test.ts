import { describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { page } from './test-support/page-protocol-fixture';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('page lease navigation loading boundary', () => {
  it('waits for an already-started navigation and rejects a file commit without attaching or forwarding events', async () => {
    const current = page(), heard = vi.fn(), lease = createPageProtocol(current.contents);
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
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
    expect(current.contents.listenerCount('did-stop-loading')).toBe(0);
    lease.close();
  });

  it('cancels one caller while loading while preserving another caller and the connection', async () => {
    const current = page(), controller = new AbortController(), lease = createPageProtocol(current.contents);
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
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
    const current = page(), lease = createPageProtocol(current.contents);
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
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
    const current = page(), lease = createPageProtocol(current.contents);
    vi.mocked(current.contents.isLoading).mockReturnValue(true);
    let outcome = 'pending';
    void lease.send('Runtime.enable').then(() => { outcome = 'opened'; }, () => { outcome = 'rejected'; });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe('rejected');
      expect(current.contents.listenerCount('did-stop-loading')).toBe(0);
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    } finally { lease.close(); vi.useRealTimers(); }
  });
});
