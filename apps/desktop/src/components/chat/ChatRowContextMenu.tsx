import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'

const log = rendererLogger('chat/row-menu')

export function ChatRowContextMenu({ chat, onPin, onSetNotificationLevel, onDelete, ...menu }: {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onDelete: () => void
}) {
  const { chats } = useChatStore('chats')
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  return <ConversationRowContextMenu {...menu} resource={{ kind: 'chat', target: { kind: 'chat', chatId: chat.id } }} state={{ kind: 'chat', pinned: chat.is_pinned,
    notificationsMuted: chat.notification_level === 'none', hasUnread: hasUnreadInRows(chatsInReadScope(chats, chat.id)), hasAnyUnread: hasUnreadInRows(chats) }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'mark-all-read') markRead()
      else if (action === 'pin') onPin()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      else if (action === 'delete-chat') void Promise.resolve().then(onDelete).catch((error: unknown) => {
        log.error({ error: String(error), chatId: chat.id }, 'delete chat failed')
        toast(t('chatList.deleteFailed'), 'error', messageForUser(error))
      })
    }} />
}
