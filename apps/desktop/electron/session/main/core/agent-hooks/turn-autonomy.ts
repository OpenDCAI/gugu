/**
 * spec hook-status-derivation —— 「这条会话此刻跑在 gugu 已经替它批准了工具的模式下吗」。
 *
 * 事实的来源是**spawn 时真的推上 argv 的那个 flag**(`AgentCommand.autoApproved`),
 * ❌ 不是事后从会话配置再推一遍那个决定:两者会分叉(resume 时被跳过的 flag、根本没声明
 * flag 的 harness、写了档位却没写布尔的记录),而分叉的方向是把一个真的阻塞在人的会话
 * 说成还在跑。没有条目 = 没推过 = 保守的那一侧,这也覆盖了 ACP 腿(它不走这条 spawn)。
 */
const autoApprovedSessions = new Set<string>();

export function setSessionAutoApproved(sessionId: string, autoApproved: boolean): void {
  if (autoApproved) autoApprovedSessions.add(sessionId);
  else autoApprovedSessions.delete(sessionId);
}

export function isSessionAutoApproved(sessionId: string): boolean {
  return autoApprovedSessions.has(sessionId);
}

export function forgetSessionAutonomy(sessionId: string): void {
  autoApprovedSessions.delete(sessionId);
}
