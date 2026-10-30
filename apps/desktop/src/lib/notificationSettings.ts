import { useSyncExternalStore } from 'react'

/**
 * @@@5301 app 设置面板这一侧的通知开关。**只管咕咕主界面这条链**（聊天新消息）；会话页 agent 的通知是另一条完全独立的链，归任务设置面板，
 * 落在 `electron/session/main/core/agent-hooks/notification.ts`。两个面板是既定结构，
 * ❌ 不要把这两套开关合并。
 *
 * 字段按**来源**切，不按状态切：用户能分辨的是「这条是谁发来的」，不是「它处于什么状态」。
 */
export type NotificationSettings = {
  /** 聊天消息：私聊新消息、群里叫到你的消息（判据见 notificationModels.shouldNotify）。 */
  chatMessages: boolean
  /**
   * 提示音：聊天系统横幅响不响。从前无条件响 —— `new Notification()` 不传 `silent`，
   * 走的是操作系统默认，用户在 app 里关不掉。
   */
  sound: boolean
}

const STORAGE_KEY = 'gugu.notification-settings'
const DEFAULT_SETTINGS: NotificationSettings = {
  chatMessages: true,
  sound: true,
}

const listeners = new Set<() => void>()
let currentSettings: NotificationSettings | null = null

/**
 * 旧结构是 `{ messages, requests }`：`messages` 管聊天，`requests` 全仓无人读
 * （死字段，#5301 第 3 条）。老用户盘里存的就是它，所以这里认它一次 —— 升级不改变任何人当前的通知行为。
 * `requests` 和已删的 `agentEvents` 直接丢弃，❌ 不要为了"兼容"把它们继续写回盘里。
 */
function migrateLegacy(parsed: Record<string, unknown>): Partial<NotificationSettings> {
  if (typeof parsed.messages !== 'boolean') return {}
  return { chatMessages: parsed.messages }
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readStoredSettings(): NotificationSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const legacy = migrateLegacy(parsed)
    return {
      chatMessages: pickBoolean(parsed.chatMessages, legacy.chatMessages ?? DEFAULT_SETTINGS.chatMessages),
      sound: pickBoolean(parsed.sound, DEFAULT_SETTINGS.sound),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function readNotificationSettings(): NotificationSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  currentSettings ??= readStoredSettings()
  return currentSettings
}

export function setNotificationSettings(patch: Partial<NotificationSettings>): NotificationSettings {
  const current = readNotificationSettings()
  const next: NotificationSettings = {
    chatMessages: pickBoolean(patch.chatMessages, current.chatMessages),
    sound: pickBoolean(patch.sound, current.sound),
  }
  if (
    next.chatMessages === current.chatMessages &&
    next.sound === current.sound
  ) {
    return current
  }
  currentSettings = next
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  emit()
  return next
}

function subscribeNotificationSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useNotificationSettings(): NotificationSettings {
  return useSyncExternalStore(
    subscribeNotificationSettings,
    readNotificationSettings,
    () => DEFAULT_SETTINGS,
  )
}
