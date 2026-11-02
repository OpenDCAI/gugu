// @vitest-environment jsdom
/**
 * #6497 —— 宿主故意停掉一条通用模式会话之后,聊天面不能攥着死句柄。
 *
 * ## 修复前是什么样(mac1 真 Electron,2026-09-25)
 *
 * 归档后几秒内「撤销」、切到编程模式又马上切回、父会话 `session_stop` 子会话 —— 三条路都是宿主把
 * 运行时里那条会话停掉(live 实例被 dispose)。session-wire 不通知订阅方,于是 `this.session` 一直指着
 * 一个已经不存在的会话:下一句「Failed to send message <会话 id>」+「Failed to sync draft」,回合停在
 * Working,引擎也不会重新起来。session_stop 那条离开 8 s 再回来照样发不出(store 从没被释放)。
 *
 * ## 现在的合同
 *
 * 运行时在 dispose 之前最后发一次 `lifecycle: 'closed'`(见 session-manager.test.ts 同号用例)。
 * 这一侧收到它:退订、`session` 置空,记录留在屏上,**不**当场重起;下一句经 custody 交给宿主,由宿主的
 * session-life 起它(页面从不自己起)。句柄留着:它的副本跟着会话 id 走,
 * 宿主自己把会话再拉起来(定时、投递、重开)时重新 seed,这一侧随即重挂(10-19)。
 *
 * ## 判据能判假吗
 *
 * 能:把 `_subscribeLiveSession` 里 `if (next.lifecycle === 'closed') …` 那一行删掉,
 * 第一条用例当场红(句柄还在、没有被还掉)—— 那正是修之前的代码。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { runInAction } from 'mobx';

const custody = vi.fn(async () => {});
vi.mock('./queue-native-input', () => ({ sendThroughCustody: custody, canQueueNativeInput: () => false }));

const toasts: Array<{ title: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string }) => {
    toasts.push(arg);
  },
}));

type StoreModule = typeof import('./acp-chat-store');
type StoreCtor = StoreModule['AcpChatStore'];
type Store = InstanceType<StoreCtor>;

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例与理由)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

/** 一份 replica 的最小形状:`current()` + `onChange()`,能从外面推一次新值。 */
function replica<T>(initial: T) {
  let value = initial;
  type Meta = { kind: 'seed' } | { kind: 'update'; mutationIds: string[] };
  const listeners = new Set<(value: T, meta: Meta) => void>();
  return {
    current: () => value,
    onChange: (cb: (value: T, meta: Meta) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: () => () => undefined,
    ready: Promise.resolve(),
    push(next: T, meta: Meta = { kind: 'update', mutationIds: [] }) {
      value = next;
      for (const listener of [...listeners]) listener(next, meta);
    },
    listenerCount: () => listeners.size,
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
const closedState = { ...readyState, lifecycle: 'closed', canSubmit: false };

function fakeSession() {
  const disposed = { value: false };
  const sendPrompt = vi.fn().mockResolvedValue({ success: true, data: undefined });
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({}),
    sendPrompt,
    dispose: () => {
      disposed.value = true;
    },
  };
  return { session, disposed, sendPrompt };
}

type Internal = {
  _bootstrapped: boolean;
  _bootstrapsInFlight: number;
  _subscribeLiveSession: (session: unknown) => void;
  _runBootstrap: () => Promise<void>;
};

let seq = 0;
function attachedStore() {
  seq += 1;
  const store = new AcpChatStore(`conv-6497-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  // 与真开场一样,进门头一件事是记下「开场在路上」(见 `_runBootstrap`);这里不往下跑 —— 用例要的就是
  // 「开场还在路上」那一段。少了这一笔,桩会让 store 以为没有开场在跑。
  const boot = vi.spyOn(internal, '_runBootstrap').mockImplementation(async () => {
    runInAction(() => {
      internal._bootstrapsInFlight += 1;
    });
  });
  const { session, disposed, sendPrompt } = fakeSession();
  runInAction(() => {
    internal._bootstrapped = true;
    store.historyLoading = false;
    store.session = session as unknown as Store['session'];
    internal._subscribeLiveSession(session);
  });
  return { store, session, disposed, sendPrompt, boot };
}

beforeEach(() => {
  toasts.length = 0;
  custody.mockClear();
});

describe('#6497 宿主停掉会话之后的聊天面', () => {
  it('makes a lost executor resumable by the next prompt through the custody send', async () => {
    const { store, session, boot, sendPrompt } = attachedStore();
    session.sessionState.push({ ...readyState, lifecycle: 'lost', failure: { message: 'executor exited' } });
    expect(store.session).toBeNull();
    expect(store.loadError).toMatchObject({ kind: 'adapter_lost', message: 'executor exited' });
    expect(store.affordances.canSubmit).toBe(true);
    expect(boot).not.toHaveBeenCalled();
    // Further loss updates are not a replacement executor becoming ready.
    session.sessionState.push({ ...readyState, lifecycle: 'lost', failure: { message: 'resume failed' } });
    expect(store.session).toBeNull();
    expect(store.affordances.canSubmit).toBe(true);
    expect(boot).not.toHaveBeenCalled();
    store.submitPrompt('resume the original conversation');
    expect(custody).toHaveBeenCalledWith(store, 'resume the original conversation', [], []);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(boot, 'the host starts it; the page attaches when it is ready').not.toHaveBeenCalled();
  });

  it('收到 closed:session 置空、界面订阅摘掉,记录留着,不当场重起', () => {
    const { store, session, disposed, boot } = attachedStore();
    // 阳性对照:被测场景成立 —— 句柄在、状态订阅挂着。
    expect(store.session).not.toBeNull();
    expect(session.sessionState.listenerCount()).toBeGreaterThan(1);

    session.sessionState.push(closedState);

    expect(store.session, '宿主停了这条会话,句柄还当活会话 = 下一句发给一个不存在的会话').toBeNull();
    expect(disposed.value, '句柄留着等宿主再拉起').toBe(false);
    expect(session.sessionState.listenerCount(), '只剩等它重新 seed 的那一个').toBe(1);
    expect(store.loadError, '故意停不是故障:没有错误可报').toBeNull();
    expect(store.affordances.isWorking).toBe(false);
    expect(store.affordances.canSubmit, '停了还要能接着发 —— 发的时候再起').toBe(true);
    expect(boot, '停是宿主的本意,聊天面不许自己把它拉起来').not.toHaveBeenCalled();
  });

  it('停了之后发的每一句都经 custody 交给宿主;页面不自己开场', () => {
    const { store, session, sendPrompt, boot } = attachedStore();
    session.sessionState.push(closedState);
    store.submitPrompt('再加 1 等于多少');
    store.submitPrompt('还有吗');
    expect((custody.mock.calls as unknown as [unknown, string][]).map(([, text]) => text)).toEqual(['再加 1 等于多少', '还有吗']);
    expect(boot).not.toHaveBeenCalled();
    expect(sendPrompt, '❌ 发给那个已经停掉的句柄').not.toHaveBeenCalled();
    expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.sendMessage'));
  });

  it('停了之后打字:草稿留在本地,不弹「Failed to sync draft」', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      session.sessionState.push(closedState);
      store.setDraftText('打了一半');
      await vi.advanceTimersByTimeAsync(400);
      expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.syncDraft'));
    } finally {
      vi.useRealTimers();
    }
  });

  // 10-19:定时 / 投递把停掉的会话又拉起来,owner 看着任务页一动不动,发了一句「1」积下的消息才一下子出来。
  it('宿主自己把会话再拉起来:留着的句柄跟上新实例,起完就重挂(只附着),不等人发一句', () => {
    const { session, disposed, boot } = attachedStore();
    session.sessionState.push(closedState);
    session.sessionState.push(closedState, { kind: 'seed' });
    session.sessionState.push({ ...readyState, lifecycle: 'starting' }, { kind: 'seed' });
    session.sessionState.push({ ...readyState, lifecycle: 'replaying' });
    expect(boot, '还停着 / 还在起:这时挂上,引擎历史缺一截').not.toHaveBeenCalled();

    session.sessionState.push({ ...readyState, lifecycle: 'working' });

    expect(boot).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledWith({ attachOnly: true });
    expect(disposed.value, '重挂时还掉留着的句柄').toBe(true);
  });

  it('旧句柄上迟到的 closed 不动当前这一个(已经换过句柄的 store)', () => {
    const { store, session } = attachedStore();
    const { session: replacement } = fakeSession();
    runInAction(() => {
      store.session = replacement as unknown as Store['session'];
    });
    session.sessionState.push(closedState);
    expect(store.session).toBe(replacement);
  });
});
