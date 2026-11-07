// #2115 普通 ACP 回合失败:composer 槽里那一条失败(宿主没在聊天里说的那种),来自失败命令行(storedAgentTurnFailures)。
// 原因是宿主落命令时分好的码(deviceCommands 的 reply_notice + reason),这里与界面都不再读原始错误。

import type { ChatItem } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'
import { displayAgentReferences } from './mentionMdast'
import { markdownPlainText } from './markdownPlainText'
import { turnFailurePresentation } from '@gugu/core/shared/turnFailurePresentation'
import type { AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'

export interface AgentTurnFailure {
  agentUserId: string
  /** 失败的 agent.deliver 命令 id——「重试」按它 CAS error→pending 重排原命令。 */
  commandId: string
  reason: AgentFailureReason
  /** 失败时刻（墙钟 ms），显示相对时间用。 */
  at: number
  /** The agent has left this chat: nothing can redeliver to it here. */
  departed: boolean
}

/** A failure row's line in the viewer's language (the chat row, the quick chat, the chat-list preview, the notification). */
export function agentFailureText(reason: AgentFailureReason): string {
  return i18n.t(turnFailurePresentation(reason).bodyKey, { ns: 'messaging' })
}

/** The chat list's last-message line: a failure row says its reason, anything else its stored preview. */
export function chatPreviewText(chat: Pick<ChatItem, 'last_message_preview' | 'last_message_failure'>): string {
  return chat.last_message_failure ? agentFailureText(chat.last_message_failure)
    : markdownPlainText(displayAgentReferences(chat.last_message_preview ?? '', (_id, label) => `@${label}`))
}
