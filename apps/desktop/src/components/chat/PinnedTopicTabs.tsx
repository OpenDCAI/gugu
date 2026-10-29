import { useMemo } from 'react'
import type { MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { PhoneChatTabs } from '@/mobile/chat/PhoneChatTabs'
import { useChatPinSettings } from './useChatPinSettings'
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
  const pins = useChatPinSettings(chatId, topics.length > 0)
  const pinned = useMemo(() => {
    const byId = new Map(topics.map((topic) => [topic.chat_id, topic]))
    return pins.topicIds.flatMap((id) => byId.get(id) ?? [])
  }, [topics, pins.topicIds])
  if (topics.length === 0) return null
  return <><TopicPinsError pins={pins} /><PhoneChatTabs topics={pinned} messages={messages} current={current} onPick={onPick} dense={!mobile} labelMax={mobile ? 9 : 16} /></>
}
