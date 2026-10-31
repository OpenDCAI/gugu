import { useEffect, useState, useSyncExternalStore } from 'react'
import { platform } from '@/platform'

// 人眼前的那条会话 = 壳报「摆在屏幕上」∧ App 在前台。选中(activeChatId)在人走开之后仍留着,不能当「在看」。
// 报的不止一处(对话页、「助理」App 里那条私聊 #7199),同一时刻至多一处摆着;按报的那一方各记一格,❌ 一个全局格互相盖。
const shownByReporter = new Map<object, string>()
// 首次宿主答复异步到达;答复之前没有「已确认前台」的资格。
let appActive = false
const listeners = new Set<() => void>()
let stopWatching: (() => void) | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    let current = true
    const stop = watchAppActive((next) => {
      if (!current) return
      appActive = next
      for (const notify of listeners) notify()
    })
    stopWatching = () => { current = false; stop() }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopWatching?.()
      stopWatching = null
      appActive = false // 下次订阅重新等宿主答复,不沿用上次的前台值。
    }
  }
}

export function chatOnScreen(): string | null {
  if (!appActive) return null
  let shown: string | null = null
  for (const chatId of shownByReporter.values()) shown = chatId
  return shown
}

/** 这条会话此刻在不在人眼前:屏上能同时摆几块对话(会话页一屏几块),哪一块摆着都算。 */
export function isChatOnScreen(chatId: string): boolean {
  return appActive && [...shownByReporter.values()].includes(chatId)
}

/** 与会话是否上报无关的同一份宿主前后台真值,供会话页的项目格子复用。 */
export function isAppActive(): boolean { return appActive }

// 前后台只信宿主:安卓「后台守着」让页面在后台仍是 visible。宿主不报时退回 visibilityState。
function watchAppActive(listener: (active: boolean) => void): () => void {
  if (platform.subscribeAppActive) return platform.subscribeAppActive(listener)
  const sync = (): void => listener(document.visibilityState === 'visible')
  sync()
  document.addEventListener('visibilitychange', sync)
  return () => document.removeEventListener('visibilitychange', sync)
}

export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, isAppActive)
}

/** 壳报此刻摆在屏幕上的会话;返回值按入参同步算,切会话那一帧不会先变成「没在看」。 */
export function useReportChatOnScreen(shown: string | null): string | null {
  const active = useAppActive()
  const [reporter] = useState(() => ({}))
  useEffect(() => {
    if (!shown) return
    shownByReporter.set(reporter, shown)
    return () => { shownByReporter.delete(reporter) }
  }, [reporter, shown])
  return active ? shown : null
}
