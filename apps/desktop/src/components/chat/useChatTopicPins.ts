import { useMemo } from 'react'
import { useChatStore } from '@/store/chatContext'
import { topicPinGroups } from './topicPinsModel'
import { useChatPinSettings } from './useChatPinSettings'

export function useChatTopicPins(chatId: string | null, enabled = true) {
  const { chats } = useChatStore('chats')
  const pins = useChatPinSettings(chatId, enabled)
  const groups = useMemo(() => topicPinGroups(chats, chatId, pins.topicIds), [chats, chatId, pins.topicIds])
  return {
    ...pins, ...groups,
    set: (topicId: string, pinned: boolean) => pins.set('pinnedTopicIds', topicId, pinned),
  }
}
