import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, conversationCanDelete, hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { useGroupChatSettings } from './useGroupChatSettings'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'
import { useAuth } from '../../store/auth'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { nativeUnreadTargets } from '../../lib/nativeUnreadTargets'

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
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const { settings, error } = useGroupChatSettings(chat.kind === 'group' || chat.kind === 'topic' ? chat.id : null)
  const peer = identitiesById[chat.peer_user_id ?? '']
  const ownedAgentDm = user && peer?.type === 'agent' && peer.owner_user_id === user.id ? peer : undefined
  const canDelete = conversationCanDelete(chat.kind, settings, ownedAgentDm)
  return <ConversationRowContextMenu {...menu} loadError={error} state={{ kind: 'chat', canDelete, pinned: chat.is_pinned,
    notificationsMuted: chat.notification_level === 'none',
    hasUnread: hasUnreadInRows(chatsInReadScope(chats, chat.id)) || nativeUnreadTargets(nativeRows, chatsInReadScope(chats, chat.id), false).length > 0,
    hasAnyUnread: hasUnreadInRows(chats) || nativeUnreadTargets(nativeRows, chats, true).length > 0 }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'mark-all-read') markRead()
      else if (action === 'pin') onPin()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      // 解散影响全体成员、撤不回:和群设置、联系人那两处解散同一句确认。
      else if (action === 'delete-chat' && canDelete && (chat.kind !== 'group' || window.confirm(t('group.settings.dissolveConfirm')))) void Promise.resolve().then(onDelete).catch((error: unknown) => {
        log.error({ error: String(error), chatId: chat.id }, 'delete chat failed')
        toast(t('chatList.deleteFailed'), 'error', messageForUser(error))
      })
    }} />
}
