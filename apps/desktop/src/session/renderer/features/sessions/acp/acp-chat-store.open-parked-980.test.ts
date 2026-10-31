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

const records = vi.hoisted(() => new Map<string, Partial<Session>>());
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
  start: vi.fn(async (_sessionId: string) => {}),
  stop: vi.fn(async (_sessionId: string) => {}),
  fork: vi.fn(async (_fork: unknown) => {}),
  end: vi.fn(async (_forkId: string) => {}),
  settle: (_sessionId: string, _kind: 'ready' | 'failed') => {},
}));
vi.mock('../stores/session-life-views', async () => {
  const { observable, runInAction } = await import('mobx');
  const views = observable.map<string, { kind: string; failure: null }>();
  life.settle = (sessionId, kind) => runInAction(() => views.set(sessionId, { kind, failure: null }));
  return {
    sessionLifeView: (sessionId: string) => views.get(sessionId) ?? null,
    startSessionLife: (sessionId: string) => life.start(sessionId),
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

beforeEach(() => {
  toasts.length = 0;
  running.phases.clear();
  running.watchers.clear();
  running.failWith = null;
  running.watchCalls = 0;
  host.storedPages = [page(turn('s0', 0), turn('s1', 1))];
  host.storedReads = [];
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

    expect(custody).toHaveBeenCalledWith(store, '接着上次的来', []);
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
});
