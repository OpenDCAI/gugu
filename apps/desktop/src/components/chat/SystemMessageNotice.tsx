import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { agentTurnFailureNeedsModelChoice } from '@/lib/agentTurnFailure'
import { AlertTriangle } from '@/lib/icons'
import { useContactsStore } from '@/store/contactsContext'
import { AgentSettingsModal } from '../agentsettings/AgentSettingsModal'
import { Button } from '../ui/Button'
import './system-message-notice.css'

export function SystemMessageNotice({ message, senderName }: { message: Pick<MessageItem, 'id' | 'content' | 'sender_user_id'>; senderName?: string }) {
  if (message.id.startsWith('turn-failure:batch:')) return <AgentReplyFailureNotice message={message} senderName={senderName} />
  return <div className="system-message-notice"><span>{message.content}</span></div>
}

function AgentReplyFailureNotice({ message, senderName }: { message: Pick<MessageItem, 'content' | 'sender_user_id'>; senderName?: string }) {
  const { t } = useTranslation('messaging')
  const { contacts } = useContactsStore()
  const [modelOpen, setModelOpen] = useState(false)
  const agent = contacts.find((contact) => contact.type === 'agent' && contact.id === message.sender_user_id)
  const canChangeModel = agentTurnFailureNeedsModelChoice(message.content)
  return (
    <>
      <div className="agent-reply-system-notice" role="status" aria-live="polite">
        <AlertTriangle size={16} className="shrink-0 text-[var(--warn)]" aria-hidden />
        <span>{senderName ? `${senderName}: ` : ''}{message.content}</span>
        {agent && canChangeModel ? (
          <Button variant="ghost" size="sm" onClick={() => setModelOpen(true)}>{t('agent.turnFailure.changeModel')}</Button>
        ) : null}
      </div>
      {modelOpen && agent ? <AgentSettingsModal agent={agent} initialTab="aimodel" onClose={() => setModelOpen(false)} /> : null}
    </>
  )
}
