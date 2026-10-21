// @vitest-environment jsdom
/**
 * #5318 —— adapter 退出之后点「重新连接」,画面必须真的换到新的那份 live model 上。
 *
 * ## 修复前是什么样(2026-09-10 真机,claude 平台模型 GLM 5.2)
 *
 * 杀掉父会话的 adapter → 面板正确地进入 lost 并给出 Reconnect;点下去,重连本身**全部成功**:
 * 新 adapter 起来了、`--resume` 带着原 transcript、被打断那一轮标成 `Turn failed`、输入框可用、
 * 新 prompt 发得出去、模型也真的答了(claude transcript 08:26:21 写下回复,运行时同一秒
 * `trigger:turn-end`)。**只有画面永远停在 Working…** —— `page.reload()` 之后同一条回复完整显示。
 *
 * ## 为什么
 *
 * 重连会**换掉运行时那份 live model**:旧会话记录连同它的 live models 一起销毁,新记录另建一份。
 * 而 `retry()` 从前不还旧 handle 就直接 `_runBootstrap()`,`AcpLiveSession.create` 在旧 handle
 * 还攥着按 conversationId 租出去的 replica 租约时执行 —— 新 handle 拿到的是同一把租约、指着
 * 已经销毁的那一份:`ready` 立刻兑现(快照还在),此后一个更新都不会来。
 * `_runBootstrap` 末尾那次 `this.session?.dispose()` 发生在 create **之后**,晚了一步。
 *
 * 邻居 `reattachAfterHostReload`(换模型时宿主停掉再按新记录重开)本来就是先还后挂 ——
 * 它没坏,恰恰因为它是这个顺序。本用例把这个顺序钉在 `retry()` 上。
 *
 * ## 判据能判假吗
 *
 * 能:把 `retry()` 里那三行(drain `_unsubs` / `dispose()` / `session = null`)删掉,
 * 三条断言全红 —— 那正是修之前的代码。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

type StoreModule = typeof import('./acp-chat-store');
type StoreCtor = StoreModule['AcpChatStore'];

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例):
// `lib/ipc.ts` 在模块求值期读 `window.electronAPI`,取不到就装 fail-loud 桩。
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

let seq = 0;

/**
 * 一个只回答「我被还掉了没有」的假 handle。真 `AcpLiveSession` 的其余表面本用例都不碰:
 * 被测的是 `retry()` 的**顺序**,不是 handle 自己的行为。
 */
function fakeSession(disposed: { value: boolean }): NonNullable<InstanceType<StoreCtor>['session']> {
  return {
    dispose: () => {
      disposed.value = true;
    },
    config: { current: () => ({}) },
  } as unknown as NonNullable<InstanceType<StoreCtor>['session']>;
}

function makeLostStore(): {
  store: InstanceType<StoreCtor>;
  disposed: { value: boolean };
  unsubscribed: { value: boolean };
} {
  seq += 1;
  const store = new AcpChatStore(`conv-5318-${seq}`, 'proj-1');
  const disposed = { value: false };
  const unsubscribed = { value: false };
  store.session = fakeSession(disposed);
  store.historyLoading = false;
  // 这正是 adapter 退出后 `sessionState` 观察者写进去的那一条(lifecycle === 'lost')。
  store.loadError = { kind: 'adapter_lost', message: 'ACP adapter exited unexpectedly' };
  (store as unknown as { _unsubs: Array<() => void> })._unsubs = [
    () => {
      unsubscribed.value = true;
    },
  ];
  return { store, disposed, unsubscribed };
}

beforeEach(() => {
  seq += 1;
});

describe('#5318 adapter 退出后的显式重连', () => {
  it('阳性对照:被测场景真的成立 —— 有一个 handle、有一条 lost 错误、retry 不会被挡回', () => {
    const { store, disposed } = makeLostStore();
    expect(store.session, '没有 handle 就无所谓「先还后挂」,这一格作废').not.toBeNull();
    expect(store.loadError?.kind).toBe('adapter_lost');
    expect(disposed.value).toBe(false);
    store.retry();
    // retry 被 historyLoading / terminal error 挡回时**什么都不会发生** —— 那样下面两条会假绿。
    // 这个 store 没有注册过 conversation,`_runBootstrap` 会同步抛 `Conversation not found`
    // 并把 loadError 换成另一种:换掉了 = 重挂流程真的跑过。
    expect(store.loadError?.kind, 'retry 没有真正进入重挂流程,下面两条读数作废').not.toBe(
      'adapter_lost',
    );
  });

  it('retry 在重新挂载之前就把旧 handle 还掉(否则新 handle 会拿到指向已销毁 live model 的租约)', () => {
    const { store, disposed } = makeLostStore();
    // `retry()` 同步走到 `void this._runBootstrap()` 为止;新 handle 的创建在那之后的微任务里。
    // 所以这一刻的读数回答的正是「还，是不是发生在挂之前」。
    store.retry();
    expect(disposed.value, '旧 handle 还攥着 replica 租约就去 create 新的 —— 那正是 #5318 的静默 Working…').toBe(true);
    expect(store.session, '旧 handle 必须先从 store 上摘下来').toBeNull();
  });

  it('retry 同时解绑旧 handle 上的 live 订阅', () => {
    const { store, unsubscribed } = makeLostStore();
    store.retry();
    expect(unsubscribed.value).toBe(true);
  });
});
