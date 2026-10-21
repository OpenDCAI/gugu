import { useCallback, useEffect, useState } from 'react';
import type { ChatView } from '@renderer/lib/chat/chat-transcript';

/** 只要求「能接住句柄」的那一面 —— 判据因此不必造一个完整的 store。 */
export type ChatViewBinder = {
  bindView(view: ChatView | null): void;
};

/**
 * @@@late-view-binding (#4452) — 把晚到的 transcript view 绑给它的 store。
 *
 * transcript view 是**异步**造出来的：`ChatTranscript` 在 `import('@gugu/session-chat-ui').then(...)`
 * 里才 `createChatView`，所以 `onReady` 必然晚于宿主组件的第一次 effect。
 * 句柄只放 ref、绑定 effect 只按 `[store]` 跑一次的写法，交给 store 的是**当时还是 null 的 ref**，
 * 而且再也不会重跑 ⇒ `store._view` 终身为 null ⇒ `this._view?.setScrollMode(...)` 这类调用
 * 在 `?.` 上整条短路：不报错、不生效、类型也不红。
 * 实测后果（#4452 B 面真机）：视口滚到顶端后发消息，画面一动不动 —— 既没滚到末尾，
 * 也没把新消息钉到视口顶端；两种设计下画面都该动。
 *
 * ⚠️ 它是**一个模块**而不是写在面板里的几行，理由只有一个：判据必须能导入**同一份**实现。
 * 判据自己抄一份同形的接线来测，测的是抄本 —— 产品那份整段回退它也不会红（实测过，
 * 这正是本文件存在的原因）。
 */
export function useBoundChatView(store: ChatViewBinder | null): {
  /** 当前已知的句柄；transcript 还没造好、或它已经没了时为 null。 */
  view: ChatView | null;
  /** transcript 造好时调用。 */
  onReady: (view: ChatView) => void;
  /**
   * transcript 没了时调用。
   *
   * ⚠️ 必须有这一条：view 被 dispose 之后仍留在 state 里的话，下一次 store 变化会把
   * **已经死掉的那个句柄**绑上去 —— 那比 null 更糟，因为 `?.` 不再短路，调用会真的落到
   * 一个已释放的 Solid root 上。
   */
  onGone: () => void;
} {
  const [view, setView] = useState<ChatView | null>(null);
  const onReady = useCallback((next: ChatView) => setView(next), []);
  const onGone = useCallback(() => setView(null), []);

  useEffect(() => {
    if (!store) return;
    store.bindView(view);
    return () => {
      store.bindView(null);
    };
  }, [store, view]);

  return { view, onReady, onGone };
}
