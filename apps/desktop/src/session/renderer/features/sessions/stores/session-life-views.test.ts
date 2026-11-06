import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeView } from '@shared/core/sessions/session-life';

const host = vi.hoisted(() => ({
  read: vi.fn(), toast: vi.fn(), machine: '',
  events: new Map<string | null, (view: LifeView) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessions: { lifeView: host.read } }),
  onMachineEvent: (machine: string | null, _channel: unknown, listener: (view: LifeView) => void) => {
    host.events.set(machine, listener); return () => {};
  },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => host.machine } }));
vi.mock('@renderer/lib/machine-clients', () => ({ machineClient: () => ({}) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: host.toast }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
import { readSessionLife } from './session-life-views';

let nextId = 0;
let current: LifeView;
beforeEach(() => {
  vi.clearAllMocks();
  host.machine = `reload-notice-machine-${++nextId}`;
  current = { sessionId: `reload-notice-session-${nextId}`, version: 1, kind: 'ready',
    stage: null, hold: null, failure: null, lastExit: null, nativeSession: null,
    pending: { count: 0, items: [] } };
  host.read.mockImplementation(async () => current);
});
function publish(patch: Partial<LifeView>) {
  current = { ...current, ...patch, version: current.version + 1 };
  const listener = host.events.get(host.machine);
  expect(listener).toBeTypeOf('function');
  listener!(current);
}

describe('reload completion notices', () => {
  it.each(['preserved', 'replaced'] as const)('does not replay an existing %s result on the first read or reopening', async nativeSession => {
    current = { ...current, nativeSession };
    await readSessionLife(current.sessionId);
    await readSessionLife(current.sessionId);
    publish({ pending: { count: 0, items: [] } });
    expect(host.toast).not.toHaveBeenCalled();
  });

  it.each(['preserved', 'replaced'] as const)('notifies once when a reload becomes ready with %s context', async nativeSession => {
    await readSessionLife(current.sessionId);
    publish({ kind: 'starting' });
    expect(host.toast).not.toHaveBeenCalled();
    publish({ kind: 'ready', nativeSession });
    expect(host.toast).toHaveBeenCalledExactlyOnceWith({
      title: nativeSession === 'preserved' ? 'chat.reloadPreserved' : 'chat.reloadReplaced', tier: 'info',
    });
    // Subsequent host updates and rereads carry the same durable result, not another completion.
    publish({ pending: { count: 0, items: [] } });
    await readSessionLife(current.sessionId);
    expect(host.toast).toHaveBeenCalledTimes(1);
  });

  it('notifies again for a later reload that preserves the same context', async () => {
    await readSessionLife(current.sessionId);
    publish({ kind: 'starting' });
    publish({ kind: 'ready', nativeSession: 'preserved' });
    publish({ kind: 'stopping', nativeSession: null });
    publish({ kind: 'starting' });
    publish({ kind: 'ready', nativeSession: 'preserved' });
    expect(host.toast).toHaveBeenCalledTimes(2);
  });

  it('does not announce initial startup or failed recovery as reload success', async () => {
    await readSessionLife(current.sessionId);
    publish({ kind: 'starting' });
    publish({ kind: 'ready', nativeSession: null });
    publish({ kind: 'starting' });
    publish({ kind: 'failed', hold: 'start-failed', failure: { at: null, message: 'Recovery refused', cause: { name: 'Error', message: 'Recovery refused' } } });
    expect(host.toast).not.toHaveBeenCalled();
    expect((await readSessionLife(current.sessionId)).failure?.message).toBe('Recovery refused');
  });

  it('ignores a stale ready snapshot after a newer reload has started', async () => {
    await readSessionLife(current.sessionId);
    const stale = { ...current, nativeSession: 'preserved' as const };
    publish({ kind: 'starting' });
    host.read.mockResolvedValueOnce(stale);
    expect((await readSessionLife(current.sessionId)).kind).toBe('starting');
    expect(host.toast).not.toHaveBeenCalled();
    publish({ kind: 'ready', nativeSession: 'preserved' });
    expect(host.toast).toHaveBeenCalledTimes(1);
  });
});
