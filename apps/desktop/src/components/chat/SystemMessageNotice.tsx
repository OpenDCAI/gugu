import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentFailureNeedsModelChoice, type AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import { turnFailureReason } from '@gugu/core/shared/ui/systemNotice'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { AlertTriangle } from '@/lib/icons'
import { useContactsStore } from '@/store/contactsContext'
import { AgentSettingsModal } from '../agentsettings/AgentSettingsModal'
import { Button } from '../ui/Button'
import './system-message-notice.css'

type NoticeMessage = Pick<MessageItem, 'id' | 'content' | 'content_type' | 'sender_user_id' | 'client_message_id'>

export function SystemMessageNotice({ message, senderName }: { message: NoticeMessage; senderName?: string }) {
  const reason = turnFailureReason(message)
  if (reason) return <AgentReplyFailureNotice reason={reason} agentUserId={message.sender_user_id} senderName={senderName} />
  return <div className="system-message-notice"><span>{message.content}</span></div>
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
