import type { AgentConversationActivity } from '@gugu/core/shared/types/chat'
import { STARTING_AGENT_RUNTIME_STATUS } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { i18n } from '@/i18n'

export type AgentNotificationContext = {
  activeChatId: string | null
  notificationsEnabled: boolean
}

export type AgentNotificationPayload = {
  title: string
  body: string
  chatId: string
}

function shouldNotifyForChatEvent(chatId: string, context: AgentNotificationContext): boolean {
  if (!context.notificationsEnabled) return false
  return chatId !== context.activeChatId
}

export function shouldNotifyForAgentStarted(
  activity: AgentConversationActivity,
  context: AgentNotificationContext,
): boolean {
  if (activity.status === STARTING_AGENT_RUNTIME_STATUS) return false
  return shouldNotifyForChatEvent(activity.chatId, context)
}

export function createAgentStartedNotificationPayload(activity: AgentConversationActivity): AgentNotificationPayload {
  return {
    title: activity.displayName,
    body: i18n.t(activity.status === 'running' ? 'agent.notification.startedWorking' : 'agent.notification.online', { ns: 'messaging' }),
    chatId: activity.chatId,
  }
}

// #2115 — 普通回合失败的系统通知（与 create 失败语义隔离:标题「回复失败」非「启动失败」）。
// 门控与其余 agent 通知同源(shouldNotifyForChatEvent):会话激活或 app 聚焦时不发——行内失败条已可见。
export function shouldNotifyForAgentTurnFailed(chatId: string, context: AgentNotificationContext): boolean {
  return shouldNotifyForChatEvent(chatId, context)
}

export function createAgentTurnFailedNotificationPayload(input: {
  chatId: string
  /** 已人话化的失败文案(agentTurnFailureUserMessage 产出),不带内部错误细节。 */
  message: string
}): AgentNotificationPayload {
  return {
    title: i18n.t('agent.notification.replyFailed', { ns: 'messaging' }),
    body: input.message,
    chatId: input.chatId,
  }
}
