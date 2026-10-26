import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentFailureNeedsModelChoice, type AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import { parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { AlertTriangle, Clock } from '@/lib/icons'
import { useContactsStore } from '@/store/contactsContext'
import { AgentSettingsModal } from '../agentsettings/AgentSettingsModal'
import { Button } from '../ui/Button'
import { InlineAction } from '../settings/addServer/InlineAction'
import './system-message-notice.css'

type NoticeMessage = Pick<MessageItem, 'id' | 'content' | 'content_type' | 'sender_user_id' | 'client_message_id'>

export function SystemMessageNotice({ message, senderName, onOpenTopic }: { message: NoticeMessage; senderName?: string; onOpenTopic?: (topicChatId: string) => void }) {
  const notice = parseSystemNotice(message)
  const reason = notice?.kind === 'turn-failure' ? notice.reason : null
  if (reason === 'notAdmitted') return <PendingDeliveryNotice />
  if (reason) return <AgentReplyFailureNotice reason={reason} agentUserId={message.sender_user_id} senderName={senderName} />
  // The server writes this one format; the marker supplies the identity even if the topic is renamed or deleted.
  const separator = ' 开了话题:'
  const split = message.content?.indexOf(separator) ?? -1
  if (notice?.kind === 'topic-opened' && onOpenTopic && split >= 0) {
    const end = split + separator.length
    return <div className="system-message-notice"><span>{message.content!.slice(0, end)}<InlineAction testId="topic-opened-link" onClick={() => onOpenTopic(notice.topicChatId)}>{message.content!.slice(end)}</InlineAction></span></div>
  }
  return <div className="system-message-notice"><span>{message.content}</span></div>
}

function PendingDeliveryNotice() {
  const { t } = useTranslation('messaging')
  return <div className="agent-reply-system-notice" role="status" aria-live="polite" data-pending-delivery="">
    <Clock size={16} className="shrink-0" aria-hidden />
    <span>{t('agent.turnFailure.notAdmitted')}</span>
  </div>
}

function AgentReplyFailureNotice({ reason, agentUserId, senderName }: { reason: AgentFailureReason; agentUserId: string | null; senderName?: string }) {
  const { t } = useTranslation('messaging')
  const { contacts } = useContactsStore()
  const [modelOpen, setModelOpen] = useState(false)
  const agent = contacts.find((contact) => contact.type === 'agent' && contact.id === agentUserId)
  return (
    <>
      <div className="agent-reply-system-notice" role="status" aria-live="polite">
        <AlertTriangle size={16} className="shrink-0 text-[var(--warn)]" aria-hidden />
        <span>{senderName ? `${senderName}: ` : ''}{t(`agent.turnFailure.${reason}`)}</span>
        {agent && agentFailureNeedsModelChoice(reason) ? (
          <Button variant="ghost" size="sm" onClick={() => setModelOpen(true)}>{t('agent.turnFailure.changeModel')}</Button>
        ) : null}
      </div>
      {modelOpen && agent ? <AgentSettingsModal agent={agent} initialTab="aimodel" onClose={() => setModelOpen(false)} /> : null}
    </>
  )
}
