import { readChatPinSettings, setChatPinPreference } from './chatPinSettings'

// Both preferences live in the same chat scope: reuse its account event/reconnect/foreground subscription.
export { watchChatAppPins as watchChatTopicPins } from './chatAppPins'

export async function readChatTopicPins(userId: string, chatId: string): Promise<string[]> {
  return (await readChatPinSettings(userId, chatId)).topicIds
}

/** A missing local topic is not proof of deletion: preserve all other saved IDs. */
export async function setChatTopicPin(userId: string, chatId: string, topicId: string, pinned: boolean, availableIds: readonly string[]): Promise<string[]> {
  if (pinned && !availableIds.includes(topicId)) throw new Error('The topic is no longer available')
  return (await setChatPinPreference(userId, chatId, 'pinnedTopicIds', topicId, pinned)).topicIds
}
