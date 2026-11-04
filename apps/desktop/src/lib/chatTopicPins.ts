import { readChatPinSettings, setChatPinPreference } from './chatPinSettings'

export { watchChatPinSettings as watchChatTopicPins } from './chatPinSettings'

export async function readChatTopicPins(userId: string, chatId: string): Promise<string[]> {
  return (await readChatPinSettings(userId, chatId)).topicIds
}

/** A missing local topic is not proof of deletion: preserve all other saved IDs. */
export async function setChatTopicPin(userId: string, chatId: string, topicId: string, pinned: boolean, availableIds: readonly string[]): Promise<string[]> {
  if (pinned && !availableIds.includes(topicId)) throw new Error('The topic is no longer available')
  return (await setChatPinPreference(userId, chatId, topicId, pinned)).topicIds
}
