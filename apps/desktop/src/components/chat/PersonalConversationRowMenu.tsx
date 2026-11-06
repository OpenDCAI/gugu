import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, conversationCanHide, hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { nativeUnreadTargets } from '../../lib/nativeUnreadTargets'
import { confirmHideConversation } from '../../lib/confirmHideConversation'
import { messageForUser } from '../../lib/userFacingError'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'

/** Explicit hide callback prevents a personal menu from accidentally invoking group archival. */
export function PersonalConversationRowMenu({ chat, onPin, onSetNotificationLevel, onHide, ...menu }: {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onHide: () => Promise<void>
}) {
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { removeOwnedAgent } = useContactsStore()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const peer = identitiesById[chat.peer_user_id ?? '']
  const owned = (chat.kind === 'dm' || chat.kind === 'ai') && user && peer?.type === 'agent'
    && peer.owner_user_id === user.id && !peer.removed_at ? peer : undefined
  const scope = chatsInReadScope(chats, chat.id)
  return <ConversationRowContextMenu {...menu} state={{ kind: 'chat', personalHiding: true,
    canDelete: conversationCanHide(chat.kind), pinned: chat.is_pinned,
    notificationsMuted: chat.notification_level === 'none',
    hasUnread: hasUnreadInRows(scope) || nativeUnreadTargets(nativeRows, scope, false).length > 0,
    hasAnyUnread: hasUnreadInRows(chats) || nativeUnreadTargets(nativeRows, chats, true).length > 0 }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'mark-all-read') markRead()
      else if (action === 'pin') onPin()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      else if (action === 'delete-chat') void confirmHideConversation({ hide: onHide,
        ownedAgent: owned ? { id: owned.id, remove: () => removeOwnedAgent(owned.id, { removeSocialIdentity: true }) } : undefined,
      }).catch((error: unknown) => toast(t('chatList.hideFailed'), 'error', messageForUser(error)))
    }} />
}
