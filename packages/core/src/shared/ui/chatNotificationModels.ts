import { chatDisplayName, unreadForYou } from './chatModels'
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
  // 话题只在叫到你的那几条涨了才弹:agent 之间的往来不叫醒被自动拉进来的主人。
  const count = unreadForYou(next)
  return count > 0 && count > (previous ? unreadForYou(previous) : 0)
}

export function createChatNotificationPayload(chat: ChatItem): ChatNotificationPayload {
  return {
    title: chatDisplayName(chat, chat.name) || '咕咕',
    body: chat.last_message_preview || '收到一条新消息',
    chatId: chat.id,
  }
}
