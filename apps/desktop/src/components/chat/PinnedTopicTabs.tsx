import type { MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { PhoneChatTabs } from '@/mobile/chat/PhoneChatTabs'
import { useChatTopicPins } from './useChatTopicPins'
import { TopicPinsError } from './GroupTopicsMenuItem'

/** One account preference feeds the existing topic strip on both phone and desktop. */
export function PinnedTopicTabs({ chatId, topics, messages, current, mobile, onPick }: {
  chatId: string
  topics: readonly TopicSummary[]
  messages: readonly MessageItem[]
  current: string | null
  mobile: boolean
  onPick: (topic: TopicSummary | null) => void
}) {
  const pins = useChatTopicPins(chatId, topics.length > 0)
  const byId = new Map(topics.map((topic) => [topic.chat_id, topic]))
  const pinned = pins.pinned.flatMap((chat) => byId.get(chat.id) ?? [])
  if (topics.length === 0) return null
  return <><TopicPinsError pins={pins} /><PhoneChatTabs topics={pinned} messages={messages} current={current} onPick={onPick} dense={!mobile} labelMax={mobile ? 9 : 16} /></>
}
