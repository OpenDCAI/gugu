import type { ChatItem } from '@gugu/core/shared/types/chat'
import { requestTopicSplit } from '@/lib/topicSplitRequest'
import { compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'

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

export function openPinnedTopic(topic: SourceTopic) {
  requestTopicSplit({ chatId: topic.id, name: topic.name, sourceChatId: topic.source_chat_id, focusComposer: true })
}
