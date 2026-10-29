import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { page } from './test-support/page-protocol-fixture';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const unknownPage = () => page(undefined, undefined, { loading: true });

describe('a navigation already loading when its observer is installed', () => {
  afterEach(() => vi.useRealTimers());

  it('waits even when the last committed URL is safe, then attaches after loading ends', async () => {
    const current = unknownPage(), lease = createPageProtocol(current.contents);
    const pending = lease.send('Runtime.enable');
    try {
      await tick();
      expect(current.contents.getURL()).toBe('https://example.test/');
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
      expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
      vi.mocked(current.contents.isLoading).mockReturnValue(false);
      current.contents.emit('did-stop-loading');
      await pending;
      expect(current.debuggerApi.attach).toHaveBeenCalledOnce();
      expect(current.debuggerApi.sendCommand).toHaveBeenCalledWith('Runtime.enable', {}, undefined);
    } finally { lease.close(); await pending.catch(() => undefined); }
  });

  it('cancels only the waiting caller while another caller can still attach', async () => {
    const current = unknownPage(), lease = createPageProtocol(current.contents), controller = new AbortController();
    const first = lease.send('Runtime.enable', { caller: 'a' }, undefined, controller.signal).then(() => 'opened', () => 'cancelled');
    const second = lease.send('Runtime.enable', { caller: 'b' });
    try {
      await tick();
      controller.abort();
      expect(await first).toBe('cancelled');
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
      vi.mocked(current.contents.isLoading).mockReturnValue(false);
      current.contents.emit('did-stop-loading');
      await second;
      expect(current.debuggerApi.sendCommand.mock.calls).toEqual([['Runtime.enable', { caller: 'b' }, undefined]]);
    } finally { lease.close(); await Promise.allSettled([first, second]); }
  });

  it('ends the unknown-destination wait at the deadline and releases its observers', async () => {
    vi.useFakeTimers();
    const current = unknownPage(), lease = createPageProtocol(current.contents);
    const pending = lease.send('Runtime.enable').then(() => 'opened', error => String(error));
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toContain('navigation is still loading');
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
      expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
      expect(current.contents.listenerCount('did-stop-loading')).toBe(1); // Only the persistent page tracker remains.
      current.destroy();
      expect(current.contents.listenerCount('did-stop-loading')).toBe(0);
    } finally { lease.close(); await pending; }
  });
});
