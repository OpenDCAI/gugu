import type { ChatItem } from '@gugu/core/shared/types/chat'
import { requestTopicSplit } from '@/lib/topicSplitRequest'
import { chatAttention, compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'

export type SourceTopic = ChatItem & { kind: 'topic'; source_chat_id: string }

export function topicPinGroups(chats: readonly ChatItem[], chatId: string | null, ids: readonly string[]) {
  const topics = chats.filter((chat): chat is SourceTopic => chatId !== null && chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const pinned = ids.flatMap((id) => byId.get(id) ?? [])
  const others = topics.filter((topic) => !ids.includes(topic.id)).sort(compareChatsByActivityDesc)
  return { topics, pinned, others }
}

export function topicUnreadTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + (topic.is_muted ? 0 : topic.unread_count), 0)
}

/** 话题里叫到你的总数:和项目行、通知同一个公式,免打扰的不算。 */
export function topicCallTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + chatAttention(topic).askingYou, 0)
}

/** 话题菜单:叫到你的排最前,其余照旧是置顶、再按活跃。 */
export function topicMenuGroups({ pinned, others }: { pinned: readonly SourceTopic[]; others: readonly SourceTopic[] }) {
  const calling = (topic: SourceTopic) => chatAttention(topic).askingYou > 0
  return [[...pinned, ...others].filter(calling), pinned.filter(topic => !calling(topic)), others.filter(topic => !calling(topic))].filter(group => group.length > 0)
}

export function openPinnedTopic(topic: SourceTopic) {
  requestTopicSplit({ chatId: topic.id, name: topic.name, sourceChatId: topic.source_chat_id, focusComposer: true })
}
