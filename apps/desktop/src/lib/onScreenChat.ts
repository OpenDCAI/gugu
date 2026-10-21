import { useEffect, useState, useSyncExternalStore } from 'react'
import { platform } from '@/platform'

// 人眼前的那条会话 = 壳报「摆在屏幕上」∧ App 在前台。选中(activeChatId)在人走开之后仍留着,不能当「在看」。
// 报的不止一处(对话页、「助理」App 里那条私聊 #7199),同一时刻至多一处摆着;按报的那一方各记一格,❌ 一个全局格互相盖。
const shownByReporter = new Map<object, string>()
let appActive = true
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function chatOnScreen(): string | null {
  if (!appActive) return null
  let shown: string | null = null
  for (const chatId of shownByReporter.values()) shown = chatId
  return shown
}

// 前后台只信宿主:安卓「后台守着」让页面在后台仍是 visible。宿主不报时退回 visibilityState。
function watchAppActive(listener: (active: boolean) => void): () => void {
  if (platform.subscribeAppActive) return platform.subscribeAppActive(listener)
  const sync = (): void => listener(document.visibilityState === 'visible')
  sync()
  document.addEventListener('visibilitychange', sync)
  return () => document.removeEventListener('visibilitychange', sync)
}

/** 壳报此刻摆在屏幕上的会话;返回值按入参同步算,切会话那一帧不会先变成「没在看」。 */
export function useReportChatOnScreen(shown: string | null): string | null {
  const active = useSyncExternalStore(subscribe, () => appActive)
  const [reporter] = useState(() => ({}))
  useEffect(() => watchAppActive((next) => {
    appActive = next
    for (const listener of listeners) listener()
  }), [])
  useEffect(() => {
    if (!shown) return
    shownByReporter.set(reporter, shown)
    return () => { shownByReporter.delete(reporter) }
  }, [reporter, shown])
  return active ? shown : null
}
