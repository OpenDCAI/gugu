import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

// Both preferences live in the same chat scope: reuse its account event/reconnect/foreground subscription.
export { watchChatAppPins as watchChatTopicPins } from './chatAppPins'
const client = identityDb as unknown as SettingsTableClient

function pinsOf(config: Record<string, unknown>): string[] {
  const ids = config.pinnedTopicIds
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) throw new Error('Invalid pinned topic preferences')
  return [...new Set(ids as string[])]
}

export async function readChatTopicPins(userId: string, chatId: string): Promise<string[]> {
  return pinsOf(await readUserSettingsConfig(client, userId, `chat:${chatId}`))
}

/** Preserve other chat preferences; remove unavailable topics only when the person next changes a pin. */
export async function setChatTopicPin(userId: string, chatId: string, topicId: string, pinned: boolean, availableIds: readonly string[]): Promise<string[]> {
  const scope = `chat:${chatId}` as const
  const config = await readUserSettingsConfig(client, userId, scope)
  const before = pinsOf(config).filter((id) => availableIds.includes(id))
  if (pinned && !availableIds.includes(topicId)) throw new Error('The topic is no longer available')
  const ids = pinned ? before.includes(topicId) ? before : [...before, topicId] : before.filter((id) => id !== topicId)
  return pinsOf((await writeUserSettingsConfig(client, userId, scope, { ...config, pinnedTopicIds: ids })).config)
}
