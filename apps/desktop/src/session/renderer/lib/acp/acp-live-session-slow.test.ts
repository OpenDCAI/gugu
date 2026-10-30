import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveClientHandle, LiveSnapshot } from '@gugu/session-wire';
import type { AcpRuntimeRpcClient } from './runtime-client';

const runtime = vi.hoisted(() => ({ client: null as unknown as AcpRuntimeRpcClient }));
vi.mock('../machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('./runtime-client', () => ({ getAcpRuntimeClient: async () => runtime.client }));
const { AcpLiveSession } = await import('./acp-live-session');

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps all eight real replicas pending for a fifteen-second backend and then attaches without a false failure', async () => {
  const detached = vi.fn();
  const snapshots = vi.fn();
  const data: Record<string, unknown> = {
    state: { lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], lastStopReason: 'end_turn', lastTurnOutcome: 'stopped',
      queuedPrompts: [], backgroundAgentCount: 0, backgroundCommandCount: 0, isGenerating: false, canSubmit: true, canCancel: false },
    config: { modelOptions: null, efforts: null, modeOptions: null, availableCommands: [], acceptsImagePrompts: false },
    usage: null, plan: null, activeTurn: null, draft: null, agents: [], terminals: [],
  };
  runtime.client = { session: { state: (_key: unknown, name: string): LiveClientHandle => ({
    topic: `session.${name}`,
    snapshot: () => {
      snapshots(name);
      return new Promise<LiveSnapshot<unknown>>(resolve => setTimeout(() => resolve({ generation: 1, sequence: 0, timestamp: Date.now(), data: data[name] }), 15_000));
    },
    attach: async () => detached,
    asLiveSource: () => { throw new Error('Not used by a state replica'); },
  }) } } as unknown as AcpRuntimeRpcClient;
  let status = 'connecting';
  let failure: unknown = null;
  const opening = AcpLiveSession.create('slow-session').then(session => { status = 'ready'; return session; }, error => { status = 'failed'; failure = error; return null; });
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    expect(snapshots).toHaveBeenCalledTimes(8);
    expect(failure, 'elapsed time does not mean the engine failed').toBeNull();
    expect(status).toBe('connecting');
    expect(detached).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    const session = await opening;
    expect(status).toBe('ready');
    expect(session?.sessionState.current()).toMatchObject({ lifecycle: 'ready', lastStopReason: 'end_turn', canSubmit: true });
    expect(session?.config.current().availableCommands).toEqual([]);
    expect(detached).not.toHaveBeenCalled();
    session?.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(detached).toHaveBeenCalledTimes(8);
  } finally { await vi.advanceTimersByTimeAsync(15_000); (await opening)?.dispose(); }
});
