import { useTranslation } from 'react-i18next'
import { agentFailureNeedsModelChoice, type AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import { isPendingDelivery, parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { TurnFailureGroup } from '@/lib/projectTurnFailureMessages'
import { useContactsStore } from '@/store/contactsContext'
import { TurnFailureCard } from './TurnFailureCard'
import { MessageSendStatus } from './MessageSendStatus'
import { InlineAction } from '../settings/addServer/InlineAction'
import './system-message-notice.css'

type NoticeMessage = Pick<MessageItem, 'id' | 'content' | 'content_type' | 'sender_user_id' | 'client_message_id' | 'local_send_state' | 'local_send_error' | 'local_send_retryable'> & {
  created_at?: string
  turnFailure?: TurnFailureGroup
}

export function SystemMessageNotice({ message, senderName, onOpenTopic }: { message: NoticeMessage; senderName?: string; onOpenTopic?: (topicChatId: string) => void }) {
  const notice = parseSystemNotice(message)
  const reason = notice?.kind === 'turn-failure' ? notice.reason : null
  // 额度/模型类失败由运行条那一排的 agent 状态位说（#7685），❌ 在消息流里再叠一行。
  if (reason && (agentFailureNeedsModelChoice(reason) || isPendingDelivery(message))) return null
  if (reason) return <AgentReplyFailureNotice reason={reason} message={message} senderName={senderName} />
  // The server writes this one format; the marker supplies the identity even if the topic is renamed or deleted.
  const separator = ' 开了话题:'
  const split = message.content?.indexOf(separator) ?? -1
  if (notice?.kind === 'topic-opened' && onOpenTopic && split >= 0) {
    const end = split + separator.length
    return <div className="system-message-notice"><span>{message.content!.slice(0, end)}<InlineAction testId="topic-opened-link" onClick={() => onOpenTopic(notice.topicChatId)}>{message.content!.slice(end)}</InlineAction></span></div>
  }
  return <div className="system-message-notice"><span>{message.content}</span>
    {message.local_send_state && <MessageSendStatus state={message.local_send_state} messageId={message.id} reason={message.local_send_error} retryable={message.local_send_retryable} />}
  </div>
}

function AgentReplyFailureNotice({ reason, message, senderName }: { reason: AgentFailureReason; message: NoticeMessage; senderName?: string }) {
  const { t } = useTranslation('messaging')
  const { contacts } = useContactsStore()
  const agent = contacts.find((contact) => contact.type === 'agent' && contact.id === message.sender_user_id)
  return (
    <TurnFailureCard reason={reason} placement="stream" displayName={senderName ?? t('agent.fallbackName')}
      agentId={message.sender_user_id} avatar={agent?.avatar} createdAt={message.created_at}
      count={message.turnFailure?.count} recovered={message.turnFailure?.recovered} />
  )
}
