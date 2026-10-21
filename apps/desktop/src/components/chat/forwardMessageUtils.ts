import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'

/** Compact, non-text-content preview label for the forwarded message. */
export function forwardPreview(
  message: Pick<MessageItem, 'content' | 'content_type'>,
  labels: { attachment: string; card: string; empty: string },
): string {
  if (message.content_type === 'attachment') return labels.attachment
  if (message.content_type === 'card') return labels.card
  const text = message.content?.trim()
  return text && text.length > 0 ? text : labels.empty
}

/** Chats that can receive a forward: not the source, and matching the query. */
export function forwardableChats(chats: ChatItem[], sourceChatId: string, query: string, displayName: (chat: ChatItem) => string): ChatItem[] {
  const q = query.trim().toLocaleLowerCase()
  return chats.filter((chat) => {
    if (chat.id === sourceChatId) return false
    if (!q) return true
    return displayName(chat).toLocaleLowerCase().includes(q)
  })
}
