import { readUserSettingsConfig, updateUserSettingsConfig, type VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'
import { platform } from '../platform'
import { rendererLogger } from './log'

export type ChatPinSettings = { topicIds: string[] }
const client = identityDb as unknown as VersionedSettingsTableClient
const scopeOf = (chatId: string) => `chat:${chatId}` as const

function idsOf(config: Record<string, unknown>): string[] {
  const value = config.pinnedTopicIds
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Invalid pinned topic preferences')
  }
  return [...new Set(value as string[])]
}

function pinsOf(config: Record<string, unknown>): ChatPinSettings {
  return { topicIds: idsOf(config) }
}

export async function readChatPinSettings(userId: string, chatId: string): Promise<ChatPinSettings> {
  return pinsOf(await readUserSettingsConfig(client, userId, scopeOf(chatId)))
}

export async function setChatPinPreference(userId: string, chatId: string, id: string, pinned: boolean): Promise<ChatPinSettings> {
  const saved = await updateUserSettingsConfig(client, userId, scopeOf(chatId), (config) => {
    const before = idsOf(config)
    const ids = pinned ? before.includes(id) ? before : [...before, id] : before.filter((value) => value !== id)
    return { ...config, pinnedTopicIds: ids }
  })
  return pinsOf(saved.config)
}

/** One account channel, including reconnect, visibility and native foreground refresh. */
export function watchChatPinSettings(userId: string, chatId: string, refresh: () => void): () => void {
  const handle = subscribePrivateUserEventBus(userId, 'setting_changed', (payload) => {
    const setting = (payload as { setting?: { user_id?: string; scope?: string } } | null)?.setting
    if (setting?.user_id === userId && setting.scope === scopeOf(chatId)) refresh()
  }, { onSubscribed: refresh })
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', refresh)
  const stopForeground = platform.subscribeAppForeground(refresh, (error) => { rendererLogger('chat/pins').error({ error }, 'Chat pin foreground subscription failed') })
  return () => {
    unsubscribePrivateUserEventBus(handle)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('online', refresh)
    stopForeground()
  }
}
