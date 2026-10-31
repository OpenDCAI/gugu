import { readChatPinSettings, setChatPinPreference } from './chatPinSettings'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'
import { platform } from '../platform'
import { rendererLogger } from './log'

const scopeOf = (chatId: string) => `chat:${chatId}` as const
const log = rendererLogger('chat/app-pins')

/** The person's shortcuts in one source chat; never the device's global App dock. */
export async function readChatAppPins(userId: string, chatId: string): Promise<string[]> {
  return (await readChatPinSettings(userId, chatId)).appIds
}

export async function setChatAppPin(userId: string, chatId: string, appId: string, pinned: boolean): Promise<string[]> {
  return (await setChatPinPreference(userId, chatId, 'pinnedAppIds', appId, pinned)).appIds
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
