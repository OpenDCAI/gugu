// @vitest-environment jsdom
/**
 * #980 打开会话不叫醒 agent(behavior session-page「打开会话不叫醒 agent」,owner 2026-10-30)。
 *
 * ## 修之前是什么样
 *
 * 「打开」= `_runBootstrap()` = 起引擎:点开、切到、重启后摆回来,
 * 每一条都把它的 agent 起一遍。重启后摆回 9 条,9 个 agent 一起起,一起卡了约 7 分钟。
 *
 * ## 现在的合同
 *
 * 打开只画对话:库里那份当场上屏;问运行时会话表它在不在跑 —— 在跑就只挂上,没在跑就停着
 * (输入框照常能用,下一句经 custody 交给宿主,由宿主起它);宿主把它拉起来,起完就挂上。
 * 新建会话带着第一句的照旧当场请宿主起(lifeStart)。agent 自己的记录里有、库里没有的几轮请主进程补,补进了就地重读,补不了不吭声。
 *
 * ## 判据能判假吗
 *
 * 能:把 `bootstrap()` 里的 `this._open()` 换回 `this._runBootstrap()`(修之前的样子),第一条用例当场红
 * (请宿主起了它:`lifeStart` 被调了)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reaction, runInAction } from 'mobx';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { Session } from '@shared/core/sessions/sessions';
import { state as inputState, changed as inputsChanged, EMPTY as NO_INPUTS } from '@/lib/sessionInputOutboxBridge';

const records = vi.hoisted(() => new Map<string, Partial<Session>>());
const link = vi.hoisted(() => ({
  state: 'open' as 'open' | 'closed',
  reconnected: new Set<() => void>(),
}));
vi.mock('@renderer/lib/machine-clients', async (original) => ({
  ...(await original<typeof import('@renderer/lib/machine-clients')>()),
  machineClient: () => ({ api: { invoke: (channel: string, ...args: unknown[]) => window.electronAPI!.invoke(channel, ...args) } }),
  machineLinkState: () => link.state,
  machineLinkHandingOff: () => false,
  onMachineReconnected: (_machine: string, listener: () => void) => {
    link.reconnected.add(listener);
    return () => link.reconnected.delete(listener);
  },
}));
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: {
    get: (id: string) =>
      records.has(id) ? { sessions: new Map([[id, { data: records.get(id) }]]) } : undefined,
  },
}));

const runtime = vi.hoisted(() => ({
  getStoredQueue: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

const custody = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('./queue-native-input', () => ({ sendThroughCustody: custody, canQueueNativeInput: () => false }));

/** session-life 的桩:`lifeStart` 记下,LifeView 由用例推(`life.settle`)。 */
const life = vi.hoisted(() => ({
  reads: 0,
  start: vi.fn(async (_sessionId: string) => {}),
  discard: vi.fn(async (_sessionId: string, _messageId: string) => {}),
  stop: vi.fn(async (_sessionId: string) => {}),
  fork: vi.fn(async (_fork: unknown) => {}),
  end: vi.fn(async (_forkId: string) => {}),
  settle: (_sessionId: string, _kind: 'ready' | 'failed', _failure?: Failure) => {},
  /** The host's view while it starts the session, with its custody rows. */
  pend: (_sessionId: string, _kind: 'starting' | 'ready' | 'failed' | 'dormant' | 'stopping', _items: PendingRow[], _hold?: string | null) => {},
  /** Sessions whose view the page asked for (the real mirror reads the host on the first ask). */
  viewed: new Set<string>(),
}));
type Failure = { at: string; message: string; cause: { name: string; message: string; data?: string } };
type PendingRow = { seq: number; messageId: string; preview: string; text: string; kind: 'ordinary'; sentAt?: number; discardable?: boolean; state: 'queued' | 'dispatching' | 'accepted' | 'failed' | 'unknown'; failure: string | null };
vi.mock('../stores/session-life-views', async () => {
  const { observable, runInAction } = await import('mobx');
  type View = { kind: string; hold: string | null; version: number; failure: Failure | null; pending: { items: PendingRow[]; count: number } };
  const views = observable.map<string, View>();
  life.settle = (sessionId, kind, failure) => runInAction(() =>
    views.set(sessionId, { kind, hold: null, version: (views.get(sessionId)?.version ?? 0) + 1, failure: failure ?? null, pending: { items: [], count: 0 } } as View));
  life.pend = (sessionId, kind, items, hold = null) => runInAction(() =>
    views.set(sessionId, { kind, hold, version: (views.get(sessionId)?.version ?? 0) + 1, failure: null, pending: { items, count: items.filter(row => row.state === 'queued' || row.state === 'dispatching').length } } as View));
  return {
    sessionLifeView: (sessionId: string) => { life.viewed.add(sessionId); return views.get(sessionId) ?? null; },
    readSessionLife: async (sessionId: string) => {
      life.reads++;
      if (!views.has(sessionId)) runInAction(() => views.set(sessionId, { kind: 'dormant', hold: null, version: 0, failure: null, pending: { items: [], count: 0 } } as View));
      return views.get(sessionId)!;
    },
    startSessionLife: (sessionId: string) => life.start(sessionId),
    discardSessionLifeRow: (sessionId: string, messageId: string) => life.discard(sessionId, messageId),
    stopSessionLife: (sessionId: string) => life.stop(sessionId),
    forkSessionLife: (fork: unknown) => life.fork(fork),
    endSessionLife: (forkId: string) => life.end(forkId),
  };
});
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => runtime,
}));

/** 运行时会话表的桩:每条会话一格 phase,`set` = 表变了一下(订着的都响)。 */
const running = vi.hoisted(() => {
  type Watcher = { sessionId: string; onChange(): void; onGone(): void };
  const phases = new Map<string, 'stopped' | 'starting' | 'running'>();
  const watchers = new Set<Watcher>();
  return {
    phases,
    watchers,
    /** null = 读不到会话表(运行时连不上)。 */
    failWith: null as Error | null,
    watchCalls: 0,
    set(sessionId: string, phase: 'stopped' | 'starting' | 'running') {
      phases.set(sessionId, phase);
      for (const watcher of [...watchers]) watcher.onChange();
    },
  };
});
vi.mock('@renderer/lib/acp/running-sessions', () => ({
  watchRunningSession: async (sessionId: string, handlers: { onChange(): void; onGone(): void }) => {
    running.watchCalls += 1;
    if (running.failWith) throw running.failWith;
    const watcher = { sessionId, ...handlers };
    running.watchers.add(watcher);
    return {
      phase: () => running.phases.get(sessionId) ?? 'stopped',
      dispose: () => running.watchers.delete(watcher),
    };
  },
}));

const create = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<unknown>>());
vi.mock('@renderer/lib/acp/acp-live-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/acp/acp-live-session')>()),
  AcpLiveSession: { create: (sessionId: string) => create(sessionId) },
}));

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (arg: unknown) => toasts.push(arg) }));

type StoredPage = { turns: TranscriptTurn[]; originTurnIds: string[]; nextCursor: number | null };
const host = {
  /** 库里那份;每读一次取队首(读完留最后一份)。 */
  storedPages: [] as StoredPage[],
  storedReads: [] as Array<{ limit?: number; fromSeq?: number }>,
  storedFailure: null as Error | null,
  storedPending: null as Promise<StoredPage> | null,
  sync: vi.fn(async (_sessionId: string): Promise<{ inserted: number }> => ({ inserted: 0 })),
};

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例与理由)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: (channel: string, ...args: unknown[]) => {
      if (channel === 'sessions.syncStoredHistoryFromRecord') return host.sync(args[0] as string);
      if (channel !== 'sessions.getStoredHistory') return Promise.resolve([]);
      const params = args[0] as { limit?: number; fromSeq?: number };
      host.storedReads.push(params);
      if (host.storedFailure) return Promise.reject(host.storedFailure);
      if (host.storedPending) return host.storedPending;
      // 开场补读那一页之后新落库的(`fromSeq`):这些用例里没有。
      if (params.fromSeq !== undefined) return Promise.resolve({ turns: [], originTurnIds: [], nextCursor: null });
      const page = host.storedPages.length > 1 ? host.storedPages.shift()! : host.storedPages[0];
      return Promise.resolve(page ?? { turns: [], originTurnIds: [], nextCursor: null });
    },
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');
const { MACHINE_LINK_GRACE_MS } = await import('./acp-chat-store');
const { machineRegistry } = await import('@renderer/lib/machine-routing');
const { isTerminalLoadError } = await import('./acp-load-error');
type Store = InstanceType<typeof AcpChatStore>;

const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [{ kind: 'message', id: `${id}-m`, seq: 0, role: 'user', text: id }] }) as unknown as TranscriptTurn;
const page = (...turns: TranscriptTurn[]): StoredPage => ({ turns, originTurnIds: turns.map((t) => `origin-${t.id}`), nextCursor: null });

function replica<T>(initial: T) {
  return { current: () => initial, onChange: () => () => {}, onGone: () => () => {}, ready: Promise.resolve() };
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

function liveSession() {
  return {
    agents: replica([] as unknown[]),
    sessionState: replica(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    canSyncDraft: () => true,
    onDraftSyncReady: () => () => {},
    terminals: replica([] as unknown[]),
    config: replica({}),
    usage: replica(null),
    getHistory: async () => ({
      success: true as const,
      data: { turns: [], nextCursor: null, cursor: { epoch: 'e1', seq: 0 }, count: 0, reset: false },
    }),
    dispose: () => {},
  };
}

let n = 0;
/** 一条已经开起来过的会话(有 provider 会话 id):打开它就是这一组要问的。 */
function storeFor(record: Partial<Session> = { providerId: 'claude', providerSessionId: 'prov-1' }) {
  n += 1;
  const store = new AcpChatStore(`conv-980-${n}`, 'proj-1');
  records.set(store.sessionId, record);
  return { store };
}

const committedIds = (store: Store) => store.chatState.transcript.state.committedTurns.map((t) => t.id);
/** 停下了:画完库、问完会话表、请过主进程补记录。 */
const parked = (store: Store) => vi.waitFor(() => {
  expect(store.historyLoading).toBe(false);
  expect(host.sync).toHaveBeenCalledWith(store.sessionId);
});

describe('sender custody uses the ordinary transcript row', () => {
  it('keeps the normal first page to one history request without a fresh lifecycle read', async () => {
    const { store } = storeFor();
    host.storedPages = [{ turns: [turn('normal', 1)], originTurnIds: ['normal'], nextCursor: 1 }];
    life.reads = 0;
    store.bootstrap();
    await parked(store);
    expect(host.storedReads).toHaveLength(1);
    expect(life.reads).toBe(0);
    expect(store.chatState.session.state.pendingMessages).toEqual([]);
  });

  it('uses restoring while an ordinary input is still sending into a resumed session', async () => {
    const { store } = storeFor({ providerId: 'claude', providerSessionId: 'prov-existing' });
    store.bootstrap();
    await parked(store);
    Object.assign(inputState(), { accountId: 'test-owner', valid: () => true, rows: [{ id: 'restoring-send',
      sessionId: store.runtimeSessionId, accountId: 'test-owner', deviceId: null, text: 'hello', createdAt: 5000, queued: false }] });
    inputsChanged();
    life.pend(store.sessionId, 'starting', []);
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'restoring-send', starting: 'restoring', delivery: { state: 'sending' } });
  });

  it('shows an unacknowledged input before a host lifecycle row exists, then keeps its accepted projection', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    life.pend(store.sessionId, 'dormant', [], 'user-stop');
    Object.assign(inputState(), { accountId: 'test-owner', valid: () => true, rows: [{ id: 'sender-input',
      sessionId: store.runtimeSessionId, accountId: 'test-owner', deviceId: null, text: 'hello', createdAt: 5000,
      queued: false, baseline: ['s0-m', 's1-m'], afterTurnId: 's1' }] });
    inputsChanged();
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'sender-input', delivery: { state: 'sending' } });
    const revision = store.transcriptRevision;
    inputsChanged();
    expect(store.transcriptRevision).toBe(revision);
    inputState().rows = [];
    inputsChanged();
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'sender-input', delivery: { state: 'accepted' } });
    store.chatState.transcript.history.seed([...store.chatState.transcript.state.committedTurns, turn('extra-history', 2)]);
    runInAction(() => { store.transcriptRevision++; });
    expect(store.chatState.session.state.pendingPrompt?.id).toBe('sender-input');
    const echo = { ...turn('echo', 3), startedAt: 5001,
      items: [{ kind: 'message' as const, id: 'native-user', seq: 0, role: 'user' as const, text: 'hello' }] };
    store.chatState.transcript.activeTurn.set(echo);
    runInAction(() => { store.transcriptRevision++; });
    inputsChanged();
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt).toBeNull());
    store.dispose();
  });

  it('keeps sender-owned input waiting in the same row without claiming the agent is working', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    Object.assign(inputState(), { accountId: 'test-owner', valid: () => true, rows: [{ id: 'failed-input',
      sessionId: store.runtimeSessionId, accountId: 'test-owner', deviceId: null, text: 'hello', createdAt: 5000,
      queued: false, failure: { code: 'send-failed', message: 'connection refused' } }] });
    inputsChanged();
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'failed-input', delivery: { state: 'waiting', retryable: false, error: 'connection refused' } });
    expect(store.affordances.isWorking).toBe(false);
    store.dispose();
  });

  it('queues a follow-up while an attached idle host has not yet echoed the first input', async () => {
    const { store } = storeFor();
    create.mockImplementation(async () => liveSession());
    running.set(store.sessionId, 'running');
    life.settle(store.sessionId, 'ready');
    store.bootstrap();
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    Object.assign(inputState(), { accountId: 'test-owner', valid: () => true, rows: [{ id: 'in-flight',
      sessionId: store.runtimeSessionId, accountId: 'test-owner', deviceId: null, text: 'hello', createdAt: 5000, queued: false }] });
    inputsChanged();
    expect(store.affordances.isWorking).toBe(true);
    inputState().rows = [];
    inputsChanged();
    expect(store.affordances.isWorking).toBe(true);
    store.dispose();
  });

  it('does not label a new unacknowledged input with a previous attempt failure', async () => {
    const { store } = storeFor();
    life.settle(store.sessionId, 'failed', { at: 'cli', message: 'Previous start failed', cause: { name: 'Error', message: 'Previous start failed' } });
    store.bootstrap();
    await parked(store);
    Object.assign(inputState(), { accountId: 'test-owner', valid: () => true, rows: [{ id: 'new-input',
      sessionId: store.runtimeSessionId, accountId: 'test-owner', deviceId: null, text: 'new attempt', createdAt: 5000, queued: false }] });
    inputsChanged();
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'new-input', delivery: { state: 'sending' } });
    store.dispose();
  });
});

beforeEach(() => {
  Object.assign(inputState(), { accountId: null, rows: NO_INPUTS, valid: () => false });
  toasts.length = 0;
  running.phases.clear();
  running.watchers.clear();
  running.failWith = null;
  running.watchCalls = 0;
  host.storedPages = [page(turn('s0', 0), turn('s1', 1))];
  host.storedReads = [];
  host.storedFailure = null;
  host.storedPending = null;
  link.state = 'open';
  link.reconnected.clear();
  host.sync.mockReset().mockResolvedValue({ inserted: 0 });
  runtime.getStoredQueue.mockClear();
  custody.mockClear();
  life.start.mockClear();
  life.stop.mockClear();
  life.fork.mockClear();
  life.end.mockClear();
  create.mockReset().mockImplementation(() => new Promise(() => {}));
});

describe('#980 打开一条没在跑的会话', () => {
  it('shows loading for a persisted conversation while its history read is pending', async () => {
    const history = Promise.withResolvers<StoredPage>();
    host.storedPending = history.promise;
    const { store } = storeFor();
    store.bootstrap();
    expect(store.isEmpty).toBe(false);
    expect(store.showHistoryLoading).toBe(true);
    history.resolve(page(turn('loaded', 0)));
    await parked(store);
    expect(store.showHistoryLoading).toBe(false);
    expect(committedIds(store)).toEqual(['loaded']);
    store.dispose();
  });

  it.each([false, true])('a failed history read stays visible and retries without starting the agent (released=%s)', async (released) => {
    const { store } = storeFor();
    if (released) {
      store.bootstrap();
      await parked(store);
      store.releaseTranscript();
    }
    host.storedFailure = new Error('history read refused');
    store.bootstrap();
    await vi.waitFor(() => expect(store.loadError).toEqual({ kind: 'history_unavailable', message: 'history read refused' }));
    expect(store.historyLoading).toBe(false);
    expect(store.showHistoryLoading).toBe(false);
    host.storedFailure = null;
    store.retry();
    await vi.waitFor(() => expect(committedIds(store)).toEqual(['s0', 's1']));
    expect(store.loadError).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(life.start).not.toHaveBeenCalled();
    store.dispose();
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])('a restored connection rereads idle history (released=%s, grace expired=%s)', async (released, expired) => {
    vi.useFakeTimers();
    const { store } = storeFor();
    const machine = 'history-remote-1306';
    machineRegistry.register(machine, [store.sessionId]);
    try {
      if (released) {
        store.bootstrap();
        await vi.advanceTimersByTimeAsync(0);
        expect(committedIds(store)).toEqual(['s0', 's1']);
        store.releaseTranscript();
      }
      link.state = 'closed';
      host.storedFailure = Object.assign(new Error('remote window closed'), { code: 'unreachable' });
      store.bootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.showHistoryLoading).toBe(true);
      if (expired) {
        await vi.advanceTimersByTimeAsync(MACHINE_LINK_GRACE_MS);
        expect(store.loadError).toMatchObject({ kind: 'connection_lost', deviceId: machine });
        expect(store.historyLoading).toBe(false);
      } else expect(store.loadError).toBeNull();
      expect(running.watchers.size).toBe(released ? 1 : 0);
      host.storedFailure = null;
      link.state = 'open';
      for (const listener of [...link.reconnected]) listener();
      await vi.advanceTimersByTimeAsync(0);
      expect(committedIds(store)).toEqual(['s0', 's1']);
      expect(store.loadError).toBeNull();
      expect(store.historyLoading).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(life.start).not.toHaveBeenCalled();
    } finally {
      store.dispose();
      machineRegistry.forgetMachine(machine);
      vi.useRealTimers();
    }
  });

  it('只画对话:库里那份上屏,❌ 起 agent;停着、输入框能用,没有「启动中」也没有失败那一行', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);

    expect(create, '打开就挂了它').not.toHaveBeenCalled();
    expect(life.start, '打开就请宿主起了 agent').not.toHaveBeenCalled();
    expect(committedIds(store)).toEqual(['s0', 's1']);
    expect(store.session).toBeNull();
    expect(store.starting, '停着不是「在起」').toBe(false);
    expect(store.loadError).toBeNull();
    expect(store.affordances.canSubmit).toBe(true);
    expect(store.affordances.isWorking).toBe(false);
    expect(toasts).toEqual([]);
    // 停着时运行时替它存着的队列照样摆出来(只读存档,不叫醒它)。
    expect(runtime.getStoredQueue).toHaveBeenCalledWith({ sessionId: store.runtimeSessionId });
  });

  it('停着时按停止:请宿主的 session-life 停它(用户的停),❌ 静默无操作', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    store.stop();
    expect(life.stop).toHaveBeenCalledWith(store.runtimeSessionId);
  });

  it('记录里补进来几轮:库里那份就地重读,❌ 再亮「加载中」', async () => {
    const backfill = Promise.withResolvers<{ inserted: number }>();
    host.sync.mockReturnValue(backfill.promise);
    host.storedPages = [page(turn('s0', 0), turn('s1', 1)), page(turn('r0', 0), turn('r1', 1), turn('s0', 2), turn('s1', 3))];
    const { store } = storeFor();
    const loading: boolean[] = [];
    store.bootstrap();
    await parked(store);
    expect(committedIds(store), '阳控:补之前画的是库里原来那份').toEqual(['s0', 's1']);
    const stop = reaction(() => store.historyLoading, (value) => loading.push(value));

    backfill.resolve({ inserted: 2 });
    await vi.waitFor(() => expect(committedIds(store)).toEqual(['r0', 'r1', 's0', 's1']));
    stop();
    expect(loading, '补齐是就地换上,❌ 闪一下加载中').not.toContain(true);
    expect(host.storedReads.at(-1)?.limit, '重读的窗口盖住屏上已有的再加补进来的').toBeGreaterThanOrEqual(100);
    expect(create).not.toHaveBeenCalled();
  });

  it('补不了(主进程抛错):屏上照旧,❌ 弹错误、❌ 失败那一行', async () => {
    host.sync.mockRejectedValue(new Error('record unreadable'));
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    await Promise.resolve();

    expect(committedIds(store)).toEqual(['s0', 's1']);
    expect(store.loadError).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('停着时发一句:经 custody 交给宿主,页面不自己起、不挂,库里那页不再读一遍', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    const readsBefore = host.storedReads.filter((read) => read.fromSeq === undefined).length;

    runInAction(() => store.submitPrompt('接着上次的来'));

    expect(custody).toHaveBeenCalledWith(store, '接着上次的来', [], []);
    expect(life.start).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(host.storedReads.filter((read) => read.fromSeq === undefined).length).toBe(readsBefore);
    expect(committedIds(store)).toEqual(['s0', 's1']);
  });

  it('库原本是空的老会话:宿主把它起起来、引擎就绪后再读一次库,补进来的历史照库上屏', async () => {
    host.sync.mockReturnValue(new Promise(() => {}));
    // 打开时读一次、挂上开场又读一次,都还是空的;宿主起会话前补完库,引擎就绪后那一读才读到。
    host.storedPages = [page(), page(), page(turn('r0', 0), turn('r1', 1))];
    create.mockImplementation(async () => liveSession());
    const { store } = storeFor();
    store.bootstrap();
    await vi.waitFor(() => expect(host.sync).toHaveBeenCalledWith(store.sessionId));
    expect(committedIds(store), '阳控:打开时库是空的').toEqual([]);

    running.set(store.runtimeSessionId, 'running');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(committedIds(store), '引擎那页只有新轮,历史来自补完的库').toEqual(['r0', 'r1']);
  });

  it('停着时宿主把它拉起来(投递、定时):起完就挂上 —— 只附着、❌ 请宿主再起一次,不等人发一句', async () => {
    create.mockImplementation(async () => liveSession());
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);

    running.set(store.runtimeSessionId, 'starting');
    expect(create, '还在起:这时挂上,引擎历史缺一截').not.toHaveBeenCalled();

    running.set(store.runtimeSessionId, 'running');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(store.sessionId);
    expect(life.start).not.toHaveBeenCalled();
    expect(host.storedReads.filter((read) => read.fromSeq === undefined), '库里那页沿用,❌ 再读一遍').toHaveLength(1);
    expect(committedIds(store)).toEqual(['s0', 's1']);
    expect(running.watchers.size, '挂上了就不再盯会话表').toBe(0);
  });

});

describe('#980 打开一条在跑的会话', () => {
  it('只挂上(❌ 请宿主起它),库里那页不再读一遍,也不去补记录', async () => {
    create.mockImplementation(async () => liveSession());
    const { store } = storeFor();
    running.phases.set(store.runtimeSessionId, 'running');

    store.bootstrap();
    await vi.waitFor(() => expect(store.session).not.toBeNull());

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(store.sessionId);
    expect(life.start).not.toHaveBeenCalled();
    expect(host.storedReads.filter((read) => read.fromSeq === undefined)).toHaveLength(1);
    expect(committedIds(store)).toEqual(['s0', 's1']);
    expect(store.loadError).toBeNull();
    expect(host.sync).not.toHaveBeenCalled();
  });
});

describe('#980 照旧当场起的', () => {
  it('新建会话带着第一句:打开就请宿主起,宿主说起好了才挂;不去问会话表', async () => {
    create.mockImplementation(async () => liveSession());
    const { store } = storeFor({
      providerId: 'claude',
      initialQueue: [{ text: '看看这个项目的启动流程', origin: 'manual' }],
    });

    store.bootstrap();

    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(store.sessionId));
    expect(store.starting).toBe(true);
    expect(create, '宿主还没说起好:❌ 先挂').not.toHaveBeenCalled();
    expect(running.watchCalls).toBe(0);

    life.settle(store.sessionId, 'ready');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(create).toHaveBeenCalledWith(store.sessionId);
  });
});

describe('the first message keeps one place while its session starts', () => {
  const row = (state: PendingRow['state']): PendingRow =>
    ({ seq: 1, messageId: 'm-first', preview: '说一句你好', text: '说一句你好', kind: 'ordinary', sentAt: 5000, discardable: true, state, failure: state === 'failed' ? 'boom' : null });

  it.each([
    { record: { providerId: 'claude', providerSessionId: 'prov-old' }, label: 'restoring' },
    { record: { providerId: 'claude', forkFromProviderSessionId: 'prov-parent' }, label: 'restoring' },
    { record: { providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] }, label: 'starting' },
  ] as const)('uses $label in the existing process line from the host lifecycle', async ({ record, label }) => {
    const { store } = storeFor(record as Partial<Session>);
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('queued')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first'));
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ starting: label, text: '说一句你好', sentAt: 5000 });
    expect(store.transcriptPendingId).toBe('m-first');
    life.pend(store.sessionId, 'ready', [row('dispatching')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.starting).toBeUndefined());
    expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first');
  });

  it('a dispatching message in a restoring session still shows restoring', async () => {
    const { store } = storeFor({ providerId: 'claude', providerSessionId: 'prov-old' });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('dispatching')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    expect(store.chatState.session.state.pendingPrompt).toMatchObject({ id: 'm-first', starting: 'restoring' });
    life.pend(store.sessionId, 'ready', [row('dispatching')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.starting).toBeUndefined());
  });

  it('the transcript draws the queued head as its next turn from the start, not the tray above the composer', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('queued')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first'));
    expect(store.chatState.session.state.pendingPrompt?.text).toBe('说一句你好');
    expect(store.transcriptPendingId, 'the tray leaves it out').toBe('m-first');
    expect(store.chatState.session.state.pendingPrompt, 'its clock is the send; its label the lifecycle').toMatchObject({ sentAt: 5000, starting: 'starting' });
    expect(store.isEmpty).toBe(false);

    // A history seed drops it (the transcript clears pendingPrompt on new committed turns): it is drawn again.
    runInAction(() => store.chatState.session.setPendingPrompt(null));
    store.transcriptRevision += 1;
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first'));

    life.pend(store.sessionId, 'ready', [row('dispatching')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.starting).toBeUndefined());
    expect(store.chatState.session.state.pendingPrompt?.sentAt, 'the same origin').toBe(5000);

    life.pend(store.sessionId, 'ready', [row('accepted')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBeNull());
    expect(store.chatState.session.state.pendingPrompt, 'kept until its turn lands: no empty frame').toMatchObject({ id: 'm-first', starting: undefined, held: false });
  });

  it('accepted means gone from the view (the real shape): kept, then taken once history has its turn', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('dispatching')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    life.pend(store.sessionId, 'ready', []);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBeNull());
    expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first');
    runInAction(() => { store.chatState.transcript.history.seed([{ ...turn('t', 0), startedAt: 5000 }]); store.transcriptRevision += 1; });
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt).toBeNull());
  });

  it('a seed that already holds its turn, then the acceptance: the row leaves at once, with no later change to trigger it', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'ready', [row('dispatching')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    runInAction(() => store.chatState.transcript.history.seed([{ ...turn('t', 0), startedAt: 5000 }]));
    expect(store.chatState.session.state.pendingPrompt?.held).toBe(true);
    life.pend(store.sessionId, 'ready', []);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt).toBeNull());
  });

  it.each([undefined, 'prov-old'])('a failed startup or recovery keeps the queued input and redraws it once after retry (%s)', async (providerSessionId) => {
    const { store } = storeFor({ providerId: 'claude', providerSessionId, initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('queued')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    expect(store.chatState.session.state.pendingPrompt?.starting).toBe(providerSessionId ? 'restoring' : 'starting');
    life.pend(store.sessionId, 'failed', [row('queued')], 'start-failed');
    expect(store.failedRowIds).toEqual(['m-first']);
    expect(store.chatState.session.state.pendingPrompt).toBeNull();
    const failed = () => store.chatState.transcript.state.committedTurns.filter(t => t.id === 'm-first:failed');
    await vi.waitFor(() => expect(failed()).toHaveLength(1));
    expect(failed()[0]).toMatchObject({ startedAt: 5000, initiator: 'user', outcome: { kind: 'error', reason: 'send_failed' }, items: [{ id: 'm-first', text: '说一句你好' }] });
    expect(failed()[0]?.outcome).not.toHaveProperty('detail');
    expect(failed()[0]?.outcome).not.toHaveProperty('said');
    life.pend(store.sessionId, 'starting', [row('dispatching')]);
    expect(store.failedRowIds).toEqual([]);
    expect(failed()).toHaveLength(0);
    expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first');
    life.pend(store.sessionId, 'failed', [row('queued')], 'effect-fault');
    expect(failed()).toHaveLength(1);
    expect(store.transcriptPendingId).toBeNull();
    store.dispose();
  });

  it('reopens and redraws every failed queued input in seq order without waking the host', async () => {
    const { store } = storeFor();
    const second = { ...row('dispatching'), seq: 2, messageId: 'm-second', text: 'second', kind: 'session-direct' as 'ordinary' };
    life.pend(store.sessionId, 'failed', [second, row('queued'), { ...row('accepted'), seq: 3, messageId: 'already-accepted' }], 'start-failed');
    store.bootstrap();
    await parked(store);
    const failed = () => store.chatState.transcript.state.committedTurns.filter(t => t.id.endsWith(':failed'));
    await vi.waitFor(() => expect(failed().map(t => t.id)).toEqual(['m-first:failed', 'm-second:failed']));
    expect(store.failedRowIds).toEqual(['m-first', 'm-second']);
    expect(failed()[1]?.initiator).toBe('agent');
    expect(life.start).not.toHaveBeenCalled();
    runInAction(() => { store.chatState.transcript.history.seed([turn('history', 0)]); store.transcriptRevision += 1; });
    expect(failed().map(t => t.id)).toEqual(['m-first:failed', 'm-second:failed']);
    expect(committedIds(store)).toEqual(['history', 'm-first:failed', 'm-second:failed']);
    store.dispose();
  });

  it('does not append failed inputs ahead of a running turn and preserves it when projections leave', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    life.pend(store.sessionId, 'failed', [row('queued')], 'start-failed');
    expect(store.failedRowIds).toEqual(['m-first']);
    runInAction(() => store.chatState.transcript.activeTurn.set({ ...turn('live', 9), items: [] }));
    life.pend(store.sessionId, 'ready', []);
    expect(store.failedRowIds).toEqual([]);
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('live');
    life.pend(store.sessionId, 'failed', [row('queued')], 'start-failed');
    expect(store.failedRowIds).toEqual([]);
    expect(committedIds(store).some(id => id.endsWith(':failed'))).toBe(false);
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('live');
    store.dispose();
  });

  it('stopped mid-start: stays where it was as a stopped turn; continuing puts it back as the next turn, once', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('queued')]);
    await vi.waitFor(() => expect(store.affordances.isWorking).toBe(true));
    expect(store.affordances.canCancel).toBe(true);

    life.pend(store.sessionId, 'dormant', [row('queued')], 'user-stop');
    await vi.waitFor(() => expect(store.stoppedRowId).toBe('m-first'));
    expect(store.transcriptPendingId, 'never again says Starting').toBeNull();
    expect(store.chatState.session.state.pendingPrompt).toBeNull();
    expect(store.affordances.isWorking).toBe(false);
    const stopped = () => store.chatState.transcript.state.committedTurns.filter(t => t.id === 'm-first:stopped');
    await vi.waitFor(() => expect(stopped()).toHaveLength(1)); // The opening's history seed may land first: drawn again after it.
    expect(stopped()[0]).toMatchObject({ startedAt: 5000, outcome: { kind: 'cancelled' }, items: [{ id: 'm-first', text: '说一句你好' }] });

    // A reconciled history drops it while it is still stopped: drawn again, once.
    runInAction(() => { store.chatState.transcript.history.seed([]); store.transcriptRevision += 1; });
    await vi.waitFor(() => expect(stopped()).toHaveLength(1));

    // The person continues: the hold is gone and the same row is on its way again.
    life.pend(store.sessionId, 'starting', [row('queued')]);
    await vi.waitFor(() => expect(store.chatState.session.state.pendingPrompt?.id).toBe('m-first'));
    expect(stopped(), 'the same words once').toHaveLength(0);
    expect(store.stoppedRowId).toBeNull();
  });

  it('reopening a session the person stopped does not start it: the stop holds until they continue', async () => {
    create.mockImplementation(async () => liveSession());
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    life.pend(store.sessionId, 'dormant', [row('queued')], 'user-stop');
    store.bootstrap();
    await vi.waitFor(() => expect(store.stoppedRowId).toBe('m-first'));
    await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.some(t => t.id === 'm-first:stopped')).toBe(true));
    expect(life.start, 'opening never undoes a stop').not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    life.pend(store.sessionId, 'ready', [row('dispatching')]);
    await vi.waitFor(() => expect(store.session).not.toBeNull());
  });

  it('继续 and 丢弃 on a stopped first message: continue only starts it; discard takes it from the host and returns the words', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    life.start.mockClear();
    store.bootstrap();
    life.pend(store.sessionId, 'dormant', [row('queued')], 'user-stop');
    await vi.waitFor(() => expect(store.stoppedRowId).toBe('m-first'));
    expect(store.canDiscardTurn('m-first:stopped')).toBe(true);
    store.continueStoppedRow();
    expect(custody, 'no prompt about continuing').not.toHaveBeenCalled();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(store.sessionId));

    store.setDraftText('已经在打的字');
    store.discardStoppedTurn('m-first:stopped');
    await vi.waitFor(() => expect(life.discard).toHaveBeenCalledWith(store.sessionId, 'm-first'));
    await vi.waitFor(() => expect(store.draftText).toBe('说一句你好\n已经在打的字'));
    life.pend(store.sessionId, 'dormant', [], 'user-stop');
    await vi.waitFor(() => expect(store.stoppedRowId).toBeNull());
    expect(store.chatState.transcript.state.committedTurns.some(t => t.id === 'm-first:stopped')).toBe(false);
  });

  it('a delivered row stays out of 丢弃, and a running turn keeps its place over a stopped row', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'dormant', [{ ...row('queued'), kind: 'session-direct' as 'ordinary', discardable: false }], 'user-stop');
    await vi.waitFor(() => expect(store.stoppedRowId).toBe('m-first'));
    await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.some(t => t.id === 'm-first:stopped')).toBe(true));
    expect(store.chatState.transcript.state.committedTurns.find(t => t.id === 'm-first:stopped')?.initiator).toBe('agent');
    expect(store.canDiscardTurn('m-first:stopped')).toBe(false);

    // The stopped turn leaves while a turn landed in the meantime: that turn survives the seed.
    const running = { ...turn('live', 9), items: [] };
    runInAction(() => store.chatState.transcript.activeTurn.set(running));
    life.pend(store.sessionId, 'ready', []);
    await vi.waitFor(() => expect(store.stoppedRowId).toBeNull());
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('live');
  });

  it('a discard the host refuses brings the folded turn back and says so', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'dormant', [row('queued')], 'user-stop');
    await vi.waitFor(() => expect(store.stoppedRowId).toBe('m-first'));
    life.discard.mockRejectedValueOnce(new Error('refused'));
    const view = store.chatState.viewState;
    view.toggleCollapsed('m-first:stopped:discarded');
    toasts.length = 0;
    store.discardStoppedTurn('m-first:stopped');
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(view.isCollapsed('m-first:stopped:discarded')).toBe(false);
    expect(store.draftText, 'the words stay queued, not doubled').toBe('');
  });

  it('stopping says nothing false and an older host (no sentAt) has no clock rather than a NaN', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    const { sentAt: _sentAt, ...old } = row('queued');
    life.pend(store.sessionId, 'starting', [old as PendingRow]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    expect(store.chatState.session.state.pendingPrompt).not.toHaveProperty('sentAt');
    life.pend(store.sessionId, 'stopping', [row('queued')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBeNull());
  });

  it('a row that fails goes back to the tray, where its failure and retry are', async () => {
    const { store } = storeFor({ providerId: 'claude', initialQueue: [{ text: '说一句你好', origin: 'manual' }] });
    store.bootstrap();
    life.pend(store.sessionId, 'starting', [row('dispatching')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBe('m-first'));
    life.pend(store.sessionId, 'starting', [row('failed')]);
    await vi.waitFor(() => expect(store.transcriptPendingId).toBeNull());
    expect(store.chatState.session.state.pendingPrompt).toBeNull();
  });
});

describe('a start answered by session-life', () => {
  const startFresh = () => {
    create.mockImplementation(async () => liveSession());
    return storeFor({ providerId: 'claude', initialQueue: [{ text: 'hello', origin: 'manual' }] }).store;
  };

  it('a typed ACP refusal becomes its load error (remedies), an untyped one keeps the stage message', async () => {
    const store = startFresh();
    store.bootstrap();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalled());
    life.settle(store.sessionId, 'failed', { at: 'channel', message: 'did not start',
      cause: { name: 'AcpStartFailed', message: 'did not start', data: JSON.stringify({ type: 'auth_required', message: 'Sign in to Claude' }) } });
    await vi.waitFor(() => expect(store.loadError).toEqual({ kind: 'auth_required', message: 'Sign in to Claude' }));

    const other = startFresh();
    other.bootstrap();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(other.sessionId));
    life.settle(other.sessionId, 'failed', { at: 'platform', message: 'Ticket refused', cause: { name: 'Error', message: 'Ticket refused' } });
    await vi.waitFor(() => expect(other.loadError?.message).toBe('Ticket refused'));
    expect(create).not.toHaveBeenCalled();
  });

  it('opening a failed session (after a restart) only says why; it starts again only on retry (contract (e))', async () => {
    const store = startFresh();
    life.settle(store.sessionId, 'failed', { at: 'identity', message: 'No identity', cause: { name: 'Error', message: 'No identity' } });
    store.bootstrap();
    await vi.waitFor(() => expect(store.loadError?.message).toBe('No identity'));
    expect(life.start).not.toHaveBeenCalled();
    runInAction(() => store.retry());
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledTimes(1));
  });

  it('a run that fails after the page attached is said on the page, without a reopen', async () => {
    const store = startFresh();
    store.bootstrap();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledTimes(1));
    life.settle(store.sessionId, 'ready');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    life.settle(store.sessionId, 'failed', { at: 'process', message: 'Worker gone', cause: { name: 'Error', message: 'Worker gone' } });
    await vi.waitFor(() => expect(store.loadError?.message).toBe('Worker gone'));
  });

  it('retry waits for the new attempt: the previous failed view does not answer it', async () => {
    const store = startFresh();
    store.bootstrap();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledTimes(1));
    life.settle(store.sessionId, 'failed', { at: 'cli', message: 'No CLI', cause: { name: 'Error', message: 'No CLI' } });
    await vi.waitFor(() => expect(store.loadError).not.toBeNull());

    runInAction(() => store.retry());
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.loadError, 'the old failed view answered the retry').toBeNull();
    expect(create).not.toHaveBeenCalled();

    life.settle(store.sessionId, 'ready');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
  });
});

describe('the parked page reads its failed state from session-life only', () => {
  const noIdentity: Failure = { at: 'identity', message: 'No identity', cause: { name: 'Error', message: 'No identity' } };

  it('a parked page whose session is failed says why and offers retry, without starting it', async () => {
    const { store } = storeFor();
    life.settle(store.sessionId, 'failed', noIdentity);
    store.bootstrap();
    expect(life.viewed.has(store.runtimeSessionId), 'the page reads the view at open').toBe(true);
    await parked(store);

    expect(store.loadError?.message).toBe('No identity');
    expect(isTerminalLoadError(store.loadError!), 'the failure row offers retry').toBe(false);
    expect(life.start).not.toHaveBeenCalled();
    runInAction(() => store.retry());
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(store.runtimeSessionId));
    expect(store.loadError, 'the retried failure is not shown again').toBeNull();
  });

  it('a send on a parked page whose start then fails says why on the page', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    expect(store.loadError).toBeNull();

    await store.submitPrompt('接着上次的来');
    life.settle(store.sessionId, 'failed', { at: 'platform', message: 'Ticket refused', cause: { name: 'Error', message: 'Ticket refused' } });

    expect(store.loadError?.message).toBe('Ticket refused');
    expect(store.historyLoading).toBe(false);
    expect(life.start, 'the host started it, not the page').not.toHaveBeenCalled();
  });
});

describe('composer send through submitPrompt', () => {
  it('a send that cannot be kept rejects to its caller (which keeps the words) and toasts once', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    custody.mockRejectedValueOnce(new Error('Task input needs a signed-in account'));

    await expect(store.submitPrompt('draft words')).rejects.toThrow('signed-in account');
    expect(toasts).toHaveLength(1);
  });

  it('a send while a message is being edited fails loud, never a silent drop', async () => {
    const { store } = storeFor();
    store.bootstrap();
    await parked(store);
    runInAction(() => { store.reverting = true; });

    await expect(store.submitPrompt('typed during a revert')).rejects.toThrow('being edited');
    expect(custody).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });
});

describe('侧边聊天:session-life 的分叉条目', () => {
  it('打开:先开分叉条目,再与持久会话同一条路请宿主起、起好才挂;关掉页面就结束它', async () => {
    create.mockImplementation(async () => liveSession());
    n += 1;
    const sourceId = `conv-980-${n}`;
    records.set(sourceId, { providerId: 'claude', providerSessionId: 'prov-1' });
    const store = new AcpChatStore(sourceId, 'proj-1', { id: `side-${n}`, forkFromProviderSessionId: 'prov-1' });

    store.bootstrap();

    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(`side-${n}`));
    expect(life.fork).toHaveBeenCalledWith({ forkId: `side-${n}`, parentId: sourceId, forkFromProviderSessionId: 'prov-1' });
    expect(life.fork.mock.invocationCallOrder[0]).toBeLessThan(life.start.mock.invocationCallOrder[0]!);
    expect(create).not.toHaveBeenCalled();

    life.settle(`side-${n}`, 'ready');
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(create).toHaveBeenCalledWith(`side-${n}`);

    store.dispose();
    await vi.waitFor(() => expect(life.end).toHaveBeenCalledWith(`side-${n}`));
  });
});

describe('#980 打开那一下读不到会话表', () => {
  it('与开场失败同一条路说出来;「再试一次」是再打开一次,❌ 借机起它', async () => {
    running.failWith = new Error('runtime unreachable');
    const { store } = storeFor();
    store.bootstrap();
    await vi.waitFor(() => expect(store.loadError).not.toBeNull());
    expect(create).not.toHaveBeenCalled();

    running.failWith = null;
    runInAction(() => store.retry());
    await parked(store);
    expect(store.loadError).toBeNull();
    expect(create, '再试一次 = 再打开一次').not.toHaveBeenCalled();

    expect(life.start).not.toHaveBeenCalled();
  });
  it('the engine no longer has the session: opening only says why; the person\'s 「Try again (reconnect)」 asks the host to load it again', async () => {
    const { store } = storeFor({ providerId: 'claude', providerSessionId: 'prov-1', providerSessionState: 'missing' });
    await (store as unknown as { _runBootstrap(options?: { retry?: boolean }): Promise<void> })._runBootstrap();
    expect(store.loadError?.kind).toBe('provider_session_missing');
    expect(life.start).not.toHaveBeenCalled();
    store.retry();
    await vi.waitFor(() => expect(life.start).toHaveBeenCalledWith(store.sessionId));
  });
});
