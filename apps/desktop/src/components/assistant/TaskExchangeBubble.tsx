import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useContactsStore } from '../../store/contactsContext'
import { Markdown } from '../markdown/Markdown'
import { Avatar } from '../Avatar'
import { buildBubbleStyle } from '../chat/messageBubbleStyle'
import './assistant-task-chat.css'

/** Read-only collaboration evidence: it has no IM reactions, delete action, or read watermark. */
export function TaskExchangeBubble({ message, mobile }: { message: MessageItem; recipientUserId: string; mobile: boolean }) {
  const { contacts } = useContactsStore()
  const { t } = useTranslation('assistant')
  const sender = contacts.find((contact) => contact.id === message.sender_user_id)
  return <div data-task-exchange="true" data-mobile={mobile || undefined} data-own={message.is_mine || undefined} className="task-exchange">
    <Avatar seed={message.sender_user_id ?? undefined} name={sender?.display_name ?? ''} avatarUrl={sender?.avatar} size="sm" isAgent still harnessBadge={false} />
    <div className="task-exchange__column">
      <div data-message-sender-name="true" className="task-exchange__who">
        {sender?.display_name ?? t('tasks.agent')}
      </div>
      <div style={buildBubbleStyle(message.is_mine, false, mobile)}><Markdown trust="chat" content={message.content ?? ''} /></div>
    </div>
  </div>
}
