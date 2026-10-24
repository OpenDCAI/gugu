import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'
import { platform } from '../platform'
import { rendererLogger } from './log'

const client = identityDb as unknown as SettingsTableClient
const scopeOf = (chatId: string) => `chat:${chatId}` as const
const log = rendererLogger('chat/app-pins')

function pinsOf(config: Record<string, unknown>): string[] {
  const ids = config.pinnedAppIds
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) throw new Error('Invalid pinned App preferences')
  return [...new Set(ids as string[])]
}

/** The person's shortcuts in one source chat; never the device's global App dock. */
export async function readChatAppPins(userId: string, chatId: string): Promise<string[]> {
  return pinsOf(await readUserSettingsConfig(client, userId, scopeOf(chatId)))
}

export async function setChatAppPin(userId: string, chatId: string, appId: string, pinned: boolean): Promise<string[]> {
  const scope = scopeOf(chatId)
  const config = await readUserSettingsConfig(client, userId, scope)
  const before = pinsOf(config)
  const ids = pinned ? before.includes(appId) ? before : [...before, appId] : before.filter((id) => id !== appId)
  const saved = await writeUserSettingsConfig(client, userId, scope, { ...config, pinnedAppIds: ids })
  return pinsOf(saved.config)
}

/** Reuse the account's physical event channel, including a reread after reconnect or returning to the app. */
export function watchChatAppPins(userId: string, chatId: string, refresh: () => void): () => void {
  const handle = subscribePrivateUserEventBus(userId, 'setting_changed', (payload) => {
    const setting = (payload as { setting?: { user_id?: string; scope?: string } } | null)?.setting
    if (setting?.user_id === userId && setting.scope === scopeOf(chatId)) refresh()
  }, { onSubscribed: refresh })
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', refresh)
  const stopForeground = platform.subscribeAppForeground(refresh, (error) => { log.error({ error }, 'App pin foreground subscription failed') })
  return () => {
    unsubscribePrivateUserEventBus(handle)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('online', refresh)
    stopForeground()
  }
}
