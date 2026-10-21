import { useSyncExternalStore } from 'react'
import { platform } from '@/platform'

/**
 * @@@5295 托盘数字角标的开关。
 *
 * 归属:app 设置面板 · 通用。角标数是**未读聊天消息**(#6433 起不再加会话页的做完未读),
 * 但它不是通知开关 —— 它是窗口外观(chrome),和「关闭时最小化到托盘」同一类。
 * ❌ 别把它塞进「聊天消息通知」或任务面板的通知卡里:关掉角标不等于关掉通知,反过来也是。
 */
const STORAGE_KEY = 'gugu.tray-badge-enabled'
const DEFAULT_ENABLED = true

const listeners = new Set<() => void>()
let current: boolean | null = null

function readStored(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_ENABLED
    return raw !== 'false'
  } catch {
    return DEFAULT_ENABLED
  }
}

export function readTrayBadgeEnabled(): boolean {
  if (typeof window === 'undefined') return DEFAULT_ENABLED
  current ??= readStored()
  return current
}

export function setTrayBadgeEnabled(enabled: boolean): void {
  if (readTrayBadgeEnabled() === enabled) return
  current = enabled
  window.localStorage.setItem(STORAGE_KEY, String(enabled))
  pushToHost(enabled)
  for (const listener of listeners) listener()
}

/**
 * 主进程不持久化这个偏好(它没有渲染层的 localStorage),所以每次启动要由渲染层推一次。
 * 平台不支持角标时静默跳过 —— 这不是错误,是这台机器上没有这个出口。
 */
export function pushToHost(enabled: boolean = readTrayBadgeEnabled()): void {
  if (!platform.capabilities.badge) return
  try {
    platform.setTrayBadgeEnabled(enabled)
  } catch {
    // 见上:平台没有这个出口就算了。
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTrayBadgeEnabled(): boolean {
  return useSyncExternalStore(subscribe, readTrayBadgeEnabled, () => DEFAULT_ENABLED)
}
