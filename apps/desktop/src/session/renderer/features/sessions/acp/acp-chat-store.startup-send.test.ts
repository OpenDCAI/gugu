// @vitest-environment jsdom
/**
 * 会话还没连上时发的消息,发出那一刻也要看得见(behavior session-page「打开速度」:第一条之外的每条同样算)。
 *
 * 修之前:这类消息走运行时的启动队列,这一侧既不画气泡、排队条也读不到它(排队条只读已连上的会话)——
 * 第一条还在「处理中」时又发一句,或回到引擎已经停掉的老会话发一句,屏上什么都没有,直到引擎起来。
 *
 * 现在的合同:
 *   没有别的在跑 ⇒ 这一句上屏、显示「处理中」,与第一条一样;
 *   已经有一句在跑 ⇒ 进排队条(锁着:运行时还没给它编号,改不了删不了),与 agent 正忙时发的一样;
 *   运行时拒收 ⇒ 撤下、字还回输入框(它没被存下,留着就是假的「已发出」);
 *   会话连上 ⇒ 交给真的那一轮 / 运行时那份真队列;
 *   眼下没有开场在跑 ⇒ 发这一句同时把开场起起来,❌ 只排队不挂(那一句会永远停在「处理中」)。
 *
 * 判据能判假吗:把 `_queuePromptDuringStartup` 里上屏 / 进排队条那一段删掉,前两条红;把 undo 里的回滚删掉,
 * 拒收那条红;把 `_handOffStartupPreviews` 删掉,「连上时还排在队列里」那条红(真的一轮已开出时会话自己就换掉了,那条测不出它);把「没有开场就起一个」那一支删掉,最后两条红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';

const queuePrompt = vi.fn();
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

let create: () => Promise<unknown> = () => new Promise(() => {});
vi.mock('@renderer/lib/acp/acp-live-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/acp/acp-live-session')>();
  return { ...actual, AcpLiveSession: { create: () => create() } };
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
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

type Internal = {
  _bootstrapped: boolean;
  _bootstrapsInFlight: number;
  _startInput: () => unknown;
  _runBootstrap: () => Promise<void>;
};

let seq = 0;
/** 会话没连上的一条老会话;`starting` = 有没有开场在跑。 */
function detachedStore(opts: { starting: boolean }) {
  seq += 1;
  const store = new AcpChatStore(`conv-startup-send-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  internal._startInput = () => ({ sessionId: store.sessionId, providerId: 'claude' });
  const boot = vi.spyOn(internal, '_runBootstrap').mockResolvedValue(undefined);
  runInAction(() => {
    internal._bootstrapped = true;
    internal._bootstrapsInFlight = opts.starting ? 1 : 0;
    store.historyLoading = false;
  });
  return { store, internal, boot };
}

const pending = (store: Store) => store.chatState.session.state.pendingPrompt;

function replica<T>(initial: T) {
  return { current: () => initial, onChange: () => () => {}, onGone: () => () => {}, ready: Promise.resolve() };
}

beforeEach(() => {
  queuePrompt.mockReset();
  queuePrompt.mockResolvedValue({ success: true, data: { queued: true } });
  create = () => new Promise(() => {});
});

describe('会话还没连上时发的消息,发出就看得见', () => {
  it('没有别的在跑:这一句上屏、显示「处理中」,同时交给运行时', async () => {
    const { store } = detachedStore({ starting: true });
    expect(store.canQueueBeforeSession, '阳控:走的确实是没连上那条路').toBe(true);
    store.submitPrompt('回到老会话说一句');
    expect(pending(store)?.text).toBe('回到老会话说一句');
    expect(pending(store)?.sentAt).toEqual(expect.any(Number));
    expect(store.queuedPrompts).toEqual([]);
    await vi.waitFor(() => expect(queuePrompt).toHaveBeenCalledOnce());
  });

  it('已经有一句在跑:进排队条、锁着,与 agent 正忙时发的一样', () => {
    const { store } = detachedStore({ starting: true });
    store.submitPrompt('第一句');
    store.submitPrompt('第二句');
    expect(pending(store)?.text, '在跑的仍是第一句').toBe('第一句');
    expect(store.queuedPrompts).toEqual([expect.objectContaining({ text: '第二句', origin: 'manual', locked: true })]);
  });

  it('主动排队(不是发送)也进排队条', () => {
    const { store } = detachedStore({ starting: true });
    store.queuePrompt('先排着');
    expect(pending(store)).toBeNull();
    expect(store.queuedPrompts.map((prompt) => prompt.text)).toEqual(['先排着']);
  });

  it('别的 agent 派来的不画(不是这里打的字)', () => {
    const { store } = detachedStore({ starting: true });
    store.submitPrompt('<gugu_delivery/>', [], undefined, 'communication');
    expect(pending(store)).toBeNull();
    expect(store.queuedPrompts).toEqual([]);
  });

  it('运行时拒收:撤下,字还回输入框;排队条里那句也撤', async () => {
    queuePrompt.mockResolvedValue({ success: false, error: { type: 'invalid_state', message: 'startup failed' } });
    const { store } = detachedStore({ starting: true });
    store.submitPrompt('会被拒的第一句');
    store.submitPrompt('会被拒的第二句');
    expect(pending(store)?.text, '阳控:先上了屏').toBe('会被拒的第一句');
    expect(store.queuedPrompts).toHaveLength(1);
    await vi.waitFor(() => expect(pending(store)).toBeNull());
    await vi.waitFor(() => expect(store.queuedPrompts).toEqual([]));
    expect(store.draftText).toBe('会被拒的第一句');
  });

  it('会话连上:上屏那句交给真的那一轮,锁着的那几句换成运行时那份真队列', async () => {
    const { store, internal, boot } = detachedStore({ starting: true });
    store.submitPrompt('第一句');
    store.submitPrompt('第二句');
    boot.mockRestore();
    internal._startInput = () => ({ sessionId: store.sessionId, providerId: 'claude' });
    const runtimeQueue = [{ id: 'rq-2', text: '第二句', origin: 'manual' }];
    const turn = {
      id: 't1', seq: 0, initiator: 'user', startedAt: Date.now(),
      items: [{ kind: 'message', id: 'm1', seq: 0, role: 'user', text: '第一句' }],
    };
    create = () => Promise.resolve({
      agents: replica([] as unknown[]),
      sessionState: replica({
        lifecycle: 'working', activeTurnId: 't1', pendingPermissions: [], lastStopReason: null, lastTurnOutcome: 'none',
        queuedPrompts: runtimeQueue, backgroundAgentCount: 0, isGenerating: true, canSubmit: true, canCancel: true, failure: null,
      }),
      activeTurn: replica(turn),
      plan: replica(null),
      draft: replica(null),
      terminals: replica([] as unknown[]),
      config: replica({}),
      getHistory: () => Promise.resolve({ success: true as const, data: { turns: [], nextCursor: null } }),
      dispose: () => {},
    });
    await (internal as unknown as { _runBootstrap: () => Promise<void> })._runBootstrap();
    expect(store.loadError, '阳控:走的是连上那条路').toBeNull();
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('t1');
    expect(pending(store)).toBeNull();
    expect(store.queuedPrompts).toEqual([expect.objectContaining({ id: 'rq-2', text: '第二句' })]);
    expect(store.queuedPrompts[0]).not.toHaveProperty('locked');
  });

  it('会话连上时那句还排在运行时队列里(没开成一轮):气泡撤下,由排队条显示,❌ 画两遍', async () => {
    const { store, internal, boot } = detachedStore({ starting: true });
    store.submitPrompt('还在排着的那句');
    expect(pending(store)?.text, '阳控:先上了屏').toBe('还在排着的那句');
    boot.mockRestore();
    create = () => Promise.resolve({
      agents: replica([] as unknown[]),
      sessionState: replica({
        lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], lastStopReason: null, lastTurnOutcome: 'none',
        queuedPrompts: [{ id: 'rq-1', text: '还在排着的那句', origin: 'manual' }],
        backgroundAgentCount: 0, isGenerating: false, canSubmit: true, canCancel: false, failure: null,
      }),
      activeTurn: replica(null),
      plan: replica(null),
      draft: replica(null),
      terminals: replica([] as unknown[]),
      config: replica({}),
      getHistory: () => Promise.resolve({ success: true as const, data: { turns: [], nextCursor: null } }),
      dispose: () => {},
    });
    await internal._runBootstrap();
    expect(store.loadError, '阳控:走的是连上那条路').toBeNull();
    expect(pending(store)).toBeNull();
    expect(store.queuedPrompts.map((prompt) => prompt.text)).toEqual(['还在排着的那句']);
  });

  it('眼下没有开场在跑:发这一句同时起开场', () => {
    const { store, boot } = detachedStore({ starting: false });
    store.submitPrompt('引擎早停了,说一句');
    expect(boot).toHaveBeenCalledOnce();
    expect(pending(store)?.text).toBe('引擎早停了,说一句');
  });

  it('起不来之后再发一句:按重试那条路重新挂上去', () => {
    const { store, boot } = detachedStore({ starting: false });
    runInAction(() => {
      store.loadError = { kind: 'generic', message: 'boom' };
    });
    expect(store.canQueueBeforeSession, '阳控:这种失败不是终态,还能发').toBe(true);
    store.submitPrompt('再试试');
    expect(boot).toHaveBeenCalledOnce();
    expect(store.loadError).toBeNull();
  });

  it('阴控:开场已经在跑时不再起第二个', () => {
    const { store, boot } = detachedStore({ starting: true });
    store.submitPrompt('说一句');
    expect(boot).not.toHaveBeenCalled();
  });
});
