import { describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { page } from './test-support/page-protocol-fixture';

describe('single-page related target boundary', () => {
  it.each([
    undefined, [], [{ type: 'service_worker' }], [{ type: 'shared_worker' }],
    [{ exclude: false }], [{ type: 'iframe', exclude: true }],
  ])('replaces caller target filters before native attachment: %j', async filter => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter });
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledWith('Target.setAutoAttach', {
      autoAttach: true, flatten: true, waitForDebuggerOnStart: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    }, undefined);
    lease.close();
  });

  it('applies the same native filter recursively inside a permitted iframe', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Runtime.enable');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 'iframe-session', targetInfo: { type: 'iframe' },
    });
    await lease.send('Target.setAutoAttach', { autoAttach: false, flatten: true, filter: [{}] }, 'iframe-session');
    expect(current.debuggerApi.sendCommand).toHaveBeenLastCalledWith('Target.setAutoAttach', {
      autoAttach: false, flatten: true, waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    }, 'iframe-session');
    lease.close();
  });

  it.each(['service_worker', 'shared_worker', 'worker', 'page', 'browser', undefined])(
    'closes on an unexpected native %s attachment without exposing or admitting its session', async type => {
      const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn(), closed = vi.fn();
      lease.onMessage(heard); lease.onClose(closed);
      await lease.send('Runtime.enable');
      current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', {
        sessionId: 'unexpected', targetInfo: { type, url: 'https://private.example/' },
      });
      expect(heard).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledWith('page protocol: unexpected related target');
      expect(current.debuggerApi.detach).toHaveBeenCalledOnce();
      await expect(lease.send('Runtime.evaluate', {}, 'unexpected')).rejects.toThrow('unexpected related target');
      expect(current.debuggerApi.sendCommand.mock.calls.map(call => call[0])).toEqual(['Runtime.enable']);
    },
  );

  it.each([{ flatten: true }, { autoAttach: 'true', flatten: true }, { autoAttach: true, flatten: false }])(
    'rejects malformed auto-attachment before native attach: %j', async params => {
      const current = page(), lease = createPageProtocol(current.contents);
      await expect(lease.send('Target.setAutoAttach', params)).rejects.toThrow('not available');
      expect(current.debuggerApi.attach).not.toHaveBeenCalled();
      lease.close();
    },
  );
});
