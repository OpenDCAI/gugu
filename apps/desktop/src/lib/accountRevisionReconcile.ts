// R2 — 修订流的对账触发器。realtime 广播是「有新东西」的提示,不是投递保证:桌面端的私有事件通道
// 关了空闲重连(reconnectWhenIdle:false),睡眠、断网、后台节流期间丢掉的 wake 不会重发 ⇒ 新消息要等
// 下一条广播才出现。这里补上与广播无关的拉取时机:定时对账 + 回到前台 / 页面可见 / 联网 / 系统唤醒。
// 每次触发都是一次 head 未知的 wake(runtime 照常合并并发、按游标增量拉),代价是一次有界的 sync_since。

export const REVISION_RECONCILE_INTERVAL_MS = 25_000

type Unsubscribe = () => void

export interface RevisionReconcileSignals {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** 页面从隐藏变为可见。 */
  onVisible(listener: () => void): Unsubscribe
  /** 网络恢复。 */
  onOnline(listener: () => void): Unsubscribe
  /** 应用回到前台:桌面端 = 窗口聚焦 + 系统从睡眠唤醒(main 的 powerMonitor.resume);移动端 = App resume。 */
  onForeground(listener: () => void): Unsubscribe
}

export function watchRevisionReconcile(
  wake: () => void,
  signals: RevisionReconcileSignals,
  intervalMs = REVISION_RECONCILE_INTERVAL_MS,
): Unsubscribe {
  const timer = signals.setInterval(wake, intervalMs)
  const stops = [signals.onVisible(wake), signals.onOnline(wake), signals.onForeground(wake)]
  return () => {
    signals.clearInterval(timer)
    for (const stop of stops) stop()
  }
}
