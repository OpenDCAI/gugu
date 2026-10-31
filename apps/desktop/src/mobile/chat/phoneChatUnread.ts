import type { ChatItem } from '@gugu/core/shared/types/chat'
import { unreadForYou } from '@gugu/core/shared/ui/chatModels'

/**
 * 手机一段对话只有一行：话题未读并入来源行，不能受当前搜索或沉降影响。
 * 并进来的话题只算叫到你的(owner 10-28,与桌面项目行、通知同一条):agent 之间的往来不把这一行点亮。
 * 手机上不知道哪些群是项目群(那份名单在桌面任务页),所以对每个群的话题都这样算 —— 与通知的口径一致。
 */
export function phoneChatUnread(chats: readonly ChatItem[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const chat of chats) {
    const source = chat.kind === 'topic' ? chat.source_chat_id : chat.id
    if (source) counts.set(source, (counts.get(source) ?? 0) + unreadForYou(chat))
  }
  return counts
}
