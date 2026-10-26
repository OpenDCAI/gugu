import type { ChatItem } from '@gugu/core/shared/types/chat'

/** 手机一段对话只有一行：话题未读并入来源行，不能受当前搜索或沉降影响。 */
export function phoneChatUnread(chats: readonly ChatItem[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const chat of chats) {
    const source = chat.kind === 'topic' ? chat.source_chat_id : chat.id
    if (source) counts.set(source, (counts.get(source) ?? 0) + chat.unread_count)
  }
  return counts
}
