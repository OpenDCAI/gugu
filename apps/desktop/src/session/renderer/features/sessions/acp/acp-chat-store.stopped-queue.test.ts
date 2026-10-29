// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import type { Session } from '@shared/core/sessions/sessions';

const getStoredQueue = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const records = vi.hoisted(() => new Map<string, Partial<Session>>());
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: {
    get: (id: string) =>
      records.has(id) ? { sessions: new Map([[id, { data: records.get(id) }]]) } : undefined,
  },
}));
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt: vi.fn(), getStoredQueue }),
}));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (arg: unknown) => toasts.push(arg) }));

type StoreModule = typeof import('./acp-chat-store');
type Store = InstanceType<StoreModule['AcpChatStore']>;

Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
const invoke = vi.fn((..._args: unknown[]) => Promise.resolve([]));
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke,
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    current: () => value,
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: () => () => undefined,
    ready: Promise.resolve(),
    push(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const readyState = {
  lifecycle: 'ready',
  activeTurnId: null,
  pendingPermissions: [],
  lastStopReason: null,
  lastTurnOutcome: 'none',
  queuedPrompts: [],
  backgroundAgentCount: 0,
  isGenerating: false,
  canSubmit: true,
  canCancel: false,
  failure: null,
};

type LiveUsage = { contextUsed: number; contextSize: number; cost: null } | null;
let seq = 0;
function attached(input: { record: Partial<Session>; liveModel: string; liveUsage: LiveUsage }) {
  seq += 1;
  const store = new AcpChatStore(`conv-7342-${seq}`, 'proj-1');
  records.set(store.sessionId, input.record);
  const internal = store as unknown as {
    _bootstrapped: boolean;
    _subscribeLiveSession: (session: unknown) => void;
    _runBootstrap: () => Promise<void>;
  };
  vi.spyOn(internal, '_runBootstrap').mockResolvedValue(undefined);
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({
      modelOptions: { selected: input.liveModel, available: [] },
      efforts: { selected: 'high', available: [] },
    }),
    usage: replica<LiveUsage>(input.liveUsage),
    dispose: () => {},
  };
  runInAction(() => {
    internal._bootstrapped = true;
    store.historyLoading = false;
    store.session = session as unknown as Store['session'];
    internal._subscribeLiveSession(session);
  });
  const close = () => session.sessionState.push({ ...readyState, lifecycle: 'closed', canSubmit: false });
  return { store, close };
}

describe('stopped queue visibility', () => {
  it('keeps stored owner and typed prompts locked, hides delivery envelopes, and clears on reattach', async () => {
    getStoredQueue.mockResolvedValueOnce([
      { text: 'owner waiting', origin: 'manual' },
      { text: '<gugu_delivery>secret delivery</gugu_delivery>', origin: 'communication' },
      { text: 'delegated waiting', origin: 'typed' },
    ]);
    const { store, close } = attached({ record: {}, liveModel: 'model', liveUsage: null });
    close();
    await vi.waitFor(() => expect(store.queuedPrompts).toEqual([
      { id: 'stored:0', text: 'owner waiting', origin: 'manual', locked: true },
      { id: 'stored:2', text: 'delegated waiting', origin: 'typed', locked: true },
    ]));
    expect(getStoredQueue).toHaveBeenCalledWith({ sessionId: store.runtimeSessionId });
    runInAction(() => store.reattachAfterHostReload());
    expect(store.queuedPrompts).toEqual([]);
  });

  it('ignores a stopped-queue reply that arrives after reattachment', async () => {
    let resolve!: (queue: Array<{ text: string; origin: string }>) => void;
    getStoredQueue.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { store, close } = attached({ record: {}, liveModel: 'model', liveUsage: null });
    close();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    runInAction(() => store.reattachAfterHostReload());
    resolve([{ text: 'stale owner queue', origin: 'manual' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.queuedPrompts).toEqual([]);
  });
});
