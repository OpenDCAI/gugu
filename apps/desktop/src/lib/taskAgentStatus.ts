import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { observedAgentPresence } from './agentPresenceMobx'

/**
 * 一条任务画成什么,侧栏(挂着的、别的机器列出的)、Needs You、手机会话列表都调它。
 * 有身份的 agent 只看共享的 presence(与头像、群里同一份),❌ 退回任务目录;没有身份的任务读宿主的任务读数。
 */
export function taskPresentation(task: {
  agentUserId: string | null | undefined
  reading: AgentStatusView | null
  unseen: boolean
  hostOnline: boolean
}): AgentStatusPresentation | null {
  if (task.agentUserId) return observedAgentPresence(task.agentUserId).presentation
  return presentAgentStatus({ reading: task.reading, unseen: task.unseen, hostOnline: task.hostOnline })
}
