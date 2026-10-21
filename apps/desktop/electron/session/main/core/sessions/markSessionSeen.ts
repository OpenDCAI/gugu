import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';

/** 打开会话 = 这一句已读。经状态写入者写(spec agent-status-writer),手机列表与宿主按 agent 的流跟着更新。 */
export function markSessionSeen(sessionId: string): Promise<void> {
  return agentStatusWriter.markSeen(sessionId);
}
