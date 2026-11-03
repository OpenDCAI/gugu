import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useContactsStore } from '../../store/contactsContext'
import { taskExchangeContent } from './taskExchangeContent'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { ReadOnlyMessageBubble } from '../chat/ReadOnlyMessageBubble'

/** Read-only collaboration evidence: it has no IM reactions, delete action, or read watermark. */
export function TaskExchangeBubble({ message, mobile, onOpenFile }: { message: MessageItem; recipientUserId: string; mobile: boolean; onOpenFile?: (file: ParsedAttachment) => void }) {
  const { contacts } = useContactsStore()
  const { t } = useTranslation('assistant')
  const content = taskExchangeContent(message.content ?? '')
  const sender = contacts.find((contact) => contact.id === message.sender_user_id)
  return <ReadOnlyMessageBubble message={message} mobile={mobile} body={content}
    sender={{ display_name: sender?.display_name ?? t('tasks.agent'), avatar: sender?.avatar, type: 'agent' }} onOpenFile={onOpenFile} />
}
