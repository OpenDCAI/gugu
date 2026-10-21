import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_LOG_CHANNEL } from '@/lib/log';
import { log } from './logger';

// The session page's log lines reach the log file the way the rest of the renderer's do: `log:write` to the host
// (written to gugu-main.log, scope renderer/sessionpage). The old `emdash:renderer-log` channel had no listener.
describe('session page logger', () => {
  const host = globalThis as { electronAPI?: unknown };

  afterEach(() => {
    delete host.electronAPI;
  });

  it('a warning goes to the host on log:write, scope sessionpage, the message and its data apart', () => {
    const invoke = vi.fn(async () => undefined);
    host.electronAPI = { invoke };

    log.warn('App slot command ignored: that slot has no running page', { slotId: 'probe' });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(RENDERER_LOG_CHANNEL, {
      scope: 'sessionpage',
      level: 'warn',
      msg: 'App slot command ignored: that slot has no running page',
      fields: { args: [{ slotId: 'probe' }] },
    });
  });

  it('an error travels as data the host can serialize, not as the message', () => {
    const invoke = vi.fn(async () => undefined);
    host.electronAPI = { invoke };

    log.error('Renderer bootstrap (embedded) failed:', new Error('a wiring line threw'));

    const [, payload] = invoke.mock.calls[0] as unknown as [string, { level: string; msg: string; fields: { args: Array<{ message?: string }> } }];
    expect(payload.level).toBe('error');
    expect(payload.msg).toBe('Renderer bootstrap (embedded) failed:');
    expect(payload.fields.args[0]?.message).toBe('a wiring line threw');
  });

  it('below the level it writes nothing', () => {
    const invoke = vi.fn(async () => undefined);
    host.electronAPI = { invoke };

    log.debug('noise');

    expect(invoke).not.toHaveBeenCalled();
  });
});
