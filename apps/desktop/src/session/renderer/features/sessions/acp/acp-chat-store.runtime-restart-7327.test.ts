// @vitest-environment jsdom
/**
 * #7327 —— 运行时进程重启过之后,聊天面不能攥着死句柄。
 *
 * ## 修复前是什么样(真 Electron 开发版,2026-10-16)
 *
 * 会话跑完一轮、停在那里;本机 ACP 运行时进程被杀掉、由宿主拉起一个新的(server 那边是升级时重起账号进程,
 * owner 同日真机撞到)。新进程里没有这条会话,旧进程也没机会先发 `closed`。重连时这份状态被拒(NOT_FOUND),
 * session-wire 的状态副本不吭声地停在旧值 ⇒ `this.session` 一直指着不存在的会话:每打一个字弹一次
 * 「草稿没存上 / 咕咕这边出错了」,发出去的那句停在「处理中…」。
 *
 * ## 现在的合同
 *
 * 状态副本 `onGone` ⇒ 与宿主停掉(#6497)同一个状态:句柄还掉、记录留着、不当场重起;打字不报错;
 * 下一句经 custody 交给宿主,由宿主的 session-life 把会话起起来。
 *
 * ## 判据能判假吗
 *
 * 能:把 `_subscribeLiveSession` 里挂 `sessionState.onGone` 那一项删掉,前三条用例当场红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { runInAction } from 'mobx';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
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
  const listeners = new Set<() => void>();
  const goneListeners = new Set<(error: { code: string }) => void>();
  return {
    current: () => value,
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: (cb: (error: { code: string }) => void) => {
      goneListeners.add(cb);
      return () => goneListeners.delete(cb);
    },
    ready: Promise.resolve(),
    push(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    /** 重连被拒、不会再好:新进程里没有这份实例。 */
    gone() {
      for (const listener of [...goneListeners]) listener({ code: 'NOT_FOUND' });
    },
    listenerCount: () => listeners.size + goneListeners.size,
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

function fakeSession() {
  const disposed = { value: false };
  const sendPrompt = vi.fn().mockResolvedValue({ success: true, data: undefined });
  // 重启后的运行时对这条会话的回答(session-manager `sessionNotFound`):拒。
  const setPromptDraft = vi.fn().mockResolvedValue({
    success: false,
    error: { type: 'conversation_not_found', message: 'conv' },
  });
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({}),
    sendPrompt,
    setPromptDraft,
    dispose: () => {
      disposed.value = true;
    },
  };
  return { session, disposed, sendPrompt };
}

type Internal = {
  _bootstrapped: boolean;
  _subscribeLiveSession: (session: unknown) => void;
  _runBootstrap: () => Promise<void>;
};

let seq = 0;
function attachedStore() {
  seq += 1;
  const store = new AcpChatStore(`conv-7327-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  const boot = vi.spyOn(internal, '_runBootstrap').mockResolvedValue(undefined);
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

describe('#7327 运行时进程重启过之后的聊天面', () => {
  it('状态副本说「没了」:session 置空、界面订阅摘掉,记录留着,不当场重起', () => {
    const { store, session, disposed, boot } = attachedStore();
    // 阳性对照:被测场景成立 —— 句柄在、订阅挂着。
    expect(store.session).not.toBeNull();
    expect(session.sessionState.listenerCount()).toBeGreaterThan(1);

    session.sessionState.gone();

    expect(store.session, '新进程里没有这条会话,句柄还当活会话 = 打字、发送都打到一个不存在的会话').toBeNull();
    expect(disposed.value, '句柄留着:新进程里同一条会话再起来时它跟得上').toBe(false);
    expect(session.sessionState.listenerCount(), '只剩等它再起来的那一个').toBe(1);
    expect(store.loadError, '进程重启不是这条会话的故障:没有错误可报').toBeNull();
    expect(store.affordances.isWorking).toBe(false);
    expect(store.affordances.canSubmit, '还要能接着发 —— 发的时候再起').toBe(true);
    expect(boot, '没人要它现在起,聊天面不自己拉起来').not.toHaveBeenCalled();
  });

  it('之后打字:草稿留在本地,不弹「草稿没存上」', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      session.sessionState.gone();
      for (const text of ['草', '草稿', '草稿测', '草稿测试']) {
        store.setDraftText(text);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(store.draftText).toBe('草稿测试');
      expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.syncDraft'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('之后的第一句:经 custody 交给宿主,页面不自己开场,❌ 发给死句柄', () => {
    const { store, session, sendPrompt, boot } = attachedStore();
    session.sessionState.gone();

    store.submitPrompt('接着说');

    expect(custody).toHaveBeenCalledWith(store, '接着说', [], []);
    expect(boot).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.sendMessage'));
  });

  it('旧句柄上迟到的「没了」不动当前这一个', () => {
    const { store, session } = attachedStore();
    const { session: replacement } = fakeSession();
    runInAction(() => {
      store.session = replacement as unknown as Store['session'];
    });
    session.sessionState.gone();
    expect(store.session).toBe(replacement);
  });
});
