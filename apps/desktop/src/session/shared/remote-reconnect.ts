// #6264「会话页里的别的机器」:和那台机器的连接断了之后怎么自己接回去 —— 各条连接共用这一份节奏,❌ 各定一套数。
//
// 节奏照 VS Code(src/vs/platform/remote/common/remoteAgentConnection.ts 的 TIMES):
// 断了立刻试一次,之后 5、5、10、10、10、10、10 秒,再往后每 30 秒一次。

export const RECONNECT_DELAYS_MS = [0, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000, 10_000, 30_000] as const;

/** 第 attempt 次重连(从 1 数)之前等多久。 */
export function reconnectDelayMs(attempt: number): number {
  const index = Math.max(0, Math.floor(attempt) - 1);
  return RECONNECT_DELAYS_MS[Math.min(index, RECONNECT_DELAYS_MS.length - 1)]!;
}

export type ReconnectPhase =
  /** 正在连。attempt = 0 是第一次连,≥1 是第几次重连。 */
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected' }
  /** 断着,retryAt(毫秒时间戳)时自动再试第 attempt 次。 */
  | { kind: 'waiting'; attempt: number; retryAt: number }
  /** 不再自动重连,等人点「重新连接」(或电脑醒来 / 重新联网)。 */
  | { kind: 'gave-up' };

/** 还剩几秒(向上取整,给倒计时用);不在等待中返回 null。 */
export function secondsUntilRetry(phase: ReconnectPhase, now: number): number | null {
  if (phase.kind !== 'waiting') return null;
  return Math.max(0, Math.ceil((phase.retryAt - now) / 1000));
}
