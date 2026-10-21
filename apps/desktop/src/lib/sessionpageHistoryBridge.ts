// @@@win-titlebar-row — 会话页 → 咕咕壳:会话页自己的后退/前进历史,给 Windows 标题栏的 ← → 用。
//
// 两棵 React 树(咕咕主渲染层 / 会话页)是同一文档里分别加载的两份模块,互相 import 不到对方的单例,
// 照既有的 window 适配对象约定(sessionpageNewSessionBridge.ts 同款)由会话页把它挂上来。
// 会话页比壳晚加载:挂桥时广播一次 READY,壳那边据此重新读 —— ❌ 否则冷启动落在任务 tab 上时,
// 按钮的可用态会一直停在「会话页还没来」那一刻。

export const SESSIONPAGE_HISTORY_KEY = '__GUGU_SESSIONPAGE_HISTORY__' as const
export const SESSIONPAGE_HISTORY_READY_EVENT = '__gugu_sessionpage_history_ready' as const

export interface SessionpageHistory {
  canGoBack(): boolean
  canGoForward(): boolean
  back(): void
  forward(): void
  /** 历史游标一动就回调(会话页自己的后退/前进、换任务、换页签都算)。返回取消订阅。 */
  subscribe(listener: () => void): () => void
}

export type SessionpageHistoryBridgeWindow = Pick<Window, 'dispatchEvent'> & {
  [SESSIONPAGE_HISTORY_KEY]?: SessionpageHistory
}

/** 会话页那一半。热更新会重新求值入口,重挂即指向新的那份 store。 */
export function installSessionpageHistoryBridge(w: SessionpageHistoryBridgeWindow, history: SessionpageHistory): void {
  w[SESSIONPAGE_HISTORY_KEY] = history
  w.dispatchEvent(new Event(SESSIONPAGE_HISTORY_READY_EVENT))
}

/** 壳那一半。这个装配里没有会话页(网页 / 手机),或它还没加载完,都是 null。 */
export function readSessionpageHistory(
  w: SessionpageHistoryBridgeWindow = window as unknown as SessionpageHistoryBridgeWindow,
): SessionpageHistory | null {
  return w[SESSIONPAGE_HISTORY_KEY] ?? null
}
