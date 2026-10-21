import type { ChatItem } from '../types/chat'

export type ChatNotificationPayload = {
  title: string
  body: string
  chatId: string
}

export type ChatNotificationContext = {
  activeChatId: string | null
  notificationsEnabled: boolean
}

export function shouldNotifyForChat(
  previous: ChatItem | undefined,
  next: ChatItem,
  context: ChatNotificationContext,
): boolean {
  if (!context.notificationsEnabled) return false
  if (next.is_muted) return false
  if (next.id === context.activeChatId) return false
  return next.unread_count > 0 && next.unread_count > (previous?.unread_count ?? 0)
}

export function createChatNotificationPayload(chat: ChatItem): ChatNotificationPayload {
  return {
    title: chat.name || '咕咕',
    body: chat.last_message_preview || '收到一条新消息',
    chatId: chat.id,
  }
}
