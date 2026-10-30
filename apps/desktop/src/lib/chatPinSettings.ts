import { readUserSettingsConfig, updateUserSettingsConfig, type VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

type PinField = 'pinnedAppIds' | 'pinnedTopicIds'
export type ChatPinSettings = { appIds: string[]; topicIds: string[] }
const client = identityDb as unknown as VersionedSettingsTableClient

function idsOf(config: Record<string, unknown>, field: PinField): string[] {
  const value = config[field]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new Error(`Invalid pinned ${field === 'pinnedAppIds' ? 'App' : 'topic'} preferences`)
  }
  return [...new Set(value as string[])]
}

function pinsOf(config: Record<string, unknown>): ChatPinSettings {
  return { appIds: idsOf(config, 'pinnedAppIds'), topicIds: idsOf(config, 'pinnedTopicIds') }
}

export async function readChatPinSettings(userId: string, chatId: string): Promise<ChatPinSettings> {
  return pinsOf(await readUserSettingsConfig(client, userId, `chat:${chatId}`))
}

export async function setChatPinPreference(userId: string, chatId: string, field: PinField, id: string, pinned: boolean): Promise<ChatPinSettings> {
  const saved = await updateUserSettingsConfig(client, userId, `chat:${chatId}`, (config) => {
    const before = idsOf(config, field)
    const ids = pinned ? before.includes(id) ? before : [...before, id] : before.filter((value) => value !== id)
    return { ...config, [field]: ids }
  })
  return pinsOf(saved.config)
}
