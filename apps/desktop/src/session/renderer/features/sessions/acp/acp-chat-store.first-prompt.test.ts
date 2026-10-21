// @vitest-environment jsdom
/**
 * 新建会话带着第一条消息起引擎:那条消息发出那一刻就上屏(behavior session-page「打开速度」)。
 *
 * 修之前:引擎起来之前转录里没有它,屏上只有一块骨架(#7298),用户看不见自己刚说的话;
 * 引擎就绪、首轮开出之后它才和「已处理 Ns」一起出现。
 *
 * 现在的合同:启动在飞时,首条以乐观行(`pendingPrompt`)挂着 —— 气泡 + 「处理中」,与之后每条
 * 消息发出时同一个样子;引擎就绪后交给真的那一轮,不留第二份;没起来(要登录、起不来)那句话留在屏上、
 * 不再显示在跑,由它下面那一行说原因;重试时换回在跑的样子,不画两遍。
 *
 * 判据能判假吗:把 `_runBootstrapInner` 里挂 `firstPromptPreview` 的那几行删掉,第一条用例红
 * (启动中 pendingPrompt 为 null);把就绪处的 `_dropFirstPromptPreview`、失败处的 `_holdStartupPrompt`、
 * 重试时摘掉留屏那一句的 seed 分别删掉,对应用例红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { runInAction } from 'mobx';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

let create: (sessionId: string, input?: unknown) => Promise<unknown> = () => new Promise(() => {});
vi.mock('@renderer/lib/acp/acp-live-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/acp/acp-live-session')>();
  return {
    ...actual,
    AcpLiveSession: {
      create: (sessionId: string, input?: unknown) => create(sessionId, input),
    },
  };
});

type StoreModule = typeof import('./acp-chat-store');
type Store = InstanceType<StoreModule['AcpChatStore']>;

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例与理由)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: (channel: string) =>
      Promise.resolve(channel === 'sessions.getStoredHistory' ? { turns: [], nextCursor: null } : []),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore, firstPromptPreview }: StoreModule = await import('./acp-chat-store');

const FIRST = '看看这个项目的启动流程';

function replica<T>(initial: T) {
  return {
    current: () => initial,
    onChange: () => () => {},
    // 运行时进程重启后副本报「没了」(#7327);这里的会话一直在。
    onGone: () => () => {},
    ready: Promise.resolve(),
  };
}

const readyState = {
  lifecycle: 'working',
  activeTurnId: null as string | null,
  pendingPermissions: [],
  lastStopReason: null,
  lastTurnOutcome: 'none',
  queuedPrompts: [],
  backgroundAgentCount: 0,
  isGenerating: true,
  canSubmit: true,
  canCancel: true,
  failure: null,
};

/** 引擎就绪那一刻的会话:`activeTurn` 为 null = 首条还排在运行时队列里。 */
function fakeSession(activeTurn: TranscriptTurn | null) {
  return {
    agents: replica([] as unknown[]),
    sessionState: replica({ ...readyState, activeTurnId: activeTurn?.id ?? null }),
    activeTurn: replica(activeTurn),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({}),
    getHistory: () => Promise.resolve({ success: true as const, data: { turns: [], nextCursor: null } }),
    dispose: () => {},
  };
}

const firstTurn: TranscriptTurn = {
  id: 'turn-1',
  seq: 0,
  initiator: 'user',
  startedAt: Date.now(),
  items: [{ kind: 'message', id: 'prompt-1', seq: 0, role: 'user', text: FIRST }],
} as TranscriptTurn;

type Internal = { _startInput: () => unknown; _runBootstrap: () => Promise<void> };

let seq = 0;
function startingStore(queue: Array<{ text: string; origin?: string }> = [{ text: FIRST, origin: 'manual' }]) {
  seq += 1;
  const store = new AcpChatStore(`conv-first-prompt-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  internal._startInput = () => ({ sessionId: store.sessionId, providerId: 'claude', initialQueue: queue });
  return { store, boot: () => internal._runBootstrap() };
}

const pending = (store: Store) => store.chatState.session.state.pendingPrompt;
const committedTexts = (store: Store) =>
  store.chatState.transcript.state.committedTurns.flatMap((turn) =>
    turn.items.flatMap((item) => (item.kind === 'message' ? [item.text] : []))
  );

beforeEach(() => {
  create = () => new Promise(() => {});
});

describe('新建会话的第一条消息,引擎起来之前就上屏', () => {
  it('启动在飞时,首条以乐观行挂着,计进消息数', async () => {
    const started = Promise.withResolvers<void>();
    create = () => {
      started.resolve();
      return new Promise(() => {});
    };
    const { store, boot } = startingStore();
    void boot();
    await started.promise;
    expect(store.session, '引擎还没挂上 —— 否则这条读数测的不是「启动中」').toBeNull();
    expect(pending(store)?.text).toBe(FIRST);
    expect(store.messageCount).toBe(1);
  });

  it('引擎就绪、首轮已开出:真的那一轮接过它,乐观行不留第二份', async () => {
    create = () => Promise.resolve(fakeSession(firstTurn));
    const { store, boot } = startingStore();
    await boot();
    expect(store.loadError).toBeNull();
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('turn-1');
    expect(pending(store)).toBeNull();
  });

  it('引擎就绪、首条还在运行时队列里:乐观行撤下(队列那一格显示它),不画两遍', async () => {
    create = () => Promise.resolve(fakeSession(null));
    const { store, boot } = startingStore();
    await boot();
    // 两条阳控:会话挂上了、而且走的是成功那条路 —— 挂接中途抛错时乐观行同样会撤(走失败分支),那就不是这条用例要测的。
    expect(store.session, '阳控:会话确实挂上了').not.toBeNull();
    expect(store.loadError, '阳控:没有走失败分支').toBeNull();
    expect(pending(store)).toBeNull();
    expect(store.chatState.transcript.state.committedTurns, '成功路径不留「没跑起来」那一句').toEqual([]);
  });

  it('没起来:那句话留在屏上、不再显示在跑(不在活动档),由失败那一行说原因', async () => {
    create = () => Promise.reject(new Error('spawn failed'));
    const { store, boot } = startingStore();
    await boot();
    expect(store.loadError, '阳控:这次启动确实失败了').not.toBeNull();
    expect(pending(store), '还挂在乐观行上 = 还画着在跑的时间头').toBeNull();
    expect(committedTexts(store)).toEqual([FIRST]);
    expect(store.messageCount).toBe(1);
  });

  it('重试:留屏的那一句换回在跑的样子,不画两遍', async () => {
    create = () => Promise.reject(new Error('auth required'));
    const { store, boot } = startingStore();
    await boot();
    expect(committedTexts(store), '阳控:第一次确实留下了那一句').toEqual([FIRST]);

    const started = Promise.withResolvers<void>();
    create = () => {
      started.resolve();
      return new Promise(() => {});
    };
    void boot();
    await started.promise;
    expect(pending(store)?.text).toBe(FIRST);
    expect(committedTexts(store)).toEqual([]);
    expect(store.messageCount).toBe(1);
  });

  it('只撤自己那一条:失败前已换成别的乐观行时,不动它', async () => {
    const fail = Promise.withResolvers<never>();
    create = () => fail.promise;
    const { store, boot } = startingStore();
    const done = boot();
    await vi.waitFor(() => expect(pending(store)?.text).toBe(FIRST));
    runInAction(() => store.chatState.session.setPendingPrompt({ id: 'other', text: '另一句' }));
    fail.reject(new Error('spawn failed'));
    await done;
    expect(pending(store)?.id).toBe('other');
    expect(committedTexts(store)).toEqual([]);
  });
});

describe('firstPromptPreview:只画用户在会话页打的那一句', () => {
  const base = { sessionId: 's1', initialQueue: [{ text: FIRST, origin: 'manual' as const }] };

  it('会话页新建:画队首那一句', () => {
    expect(firstPromptPreview(base)).toEqual({ id: 'first-prompt:s1', text: FIRST });
    expect(firstPromptPreview({ ...base, startupOrigin: 'session-page' })?.text).toBe(FIRST);
  });

  it('聊天页起的会话:首条会被宿主换成投递,不画', () => {
    expect(firstPromptPreview({ ...base, startupOrigin: 'chat-page' })).toBeNull();
  });

  it('别的 agent 派来的首条:不画', () => {
    expect(firstPromptPreview({ sessionId: 's1', initialQueue: [{ text: FIRST, origin: 'communication' }] })).toBeNull();
  });

  it('没有首条(空会话、纯附着、已建立过的会话):不画', () => {
    expect(firstPromptPreview(undefined)).toBeNull();
    expect(firstPromptPreview({ sessionId: 's1' })).toBeNull();
    expect(firstPromptPreview({ sessionId: 's1', initialQueue: [] })).toBeNull();
  });
});
