import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  ShellNavigationHistory,
  type ShellLocation,
  type ShellLocationReachable,
} from '../lib/shellNavigationHistory'
import {
  readSessionpageHistory,
  SESSIONPAGE_HISTORY_READY_EVENT,
  type SessionpageHistory,
} from '../lib/sessionpageHistoryBridge'

export interface ShellNavigation {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
}

/** 鼠标侧键:MouseEvent.button 3 = 后退(XButton1)、4 = 前进(XButton2)。 */
const MOUSE_BACK_BUTTON = 3
const MOUSE_FORWARD_BUTTON = 4

function locationKey(location: ShellLocation): string {
  return location.tab === 'chats' ? `chats:${location.chatId ?? ''}` : location.tab
}

function useSessionpageHistory(): SessionpageHistory | null {
  const [history, setHistory] = useState<SessionpageHistory | null>(() => readSessionpageHistory())
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    // 会话页比壳晚加载(也会热更新重挂),挂上来时广播一次,这里重新读。
    const onReady = () => setHistory(readSessionpageHistory())
    window.addEventListener(SESSIONPAGE_HISTORY_READY_EVENT, onReady)
    onReady()
    return () => window.removeEventListener(SESSIONPAGE_HISTORY_READY_EVENT, onReady)
  }, [])

  // 会话页的游标一动(它自己的 ← →、换任务、换页签),按钮的可用态跟着重算。
  useEffect(() => history?.subscribe(rerender), [history])

  return history
}

/**
 * @@@win-titlebar-row — 标题栏「后退 / 前进」的两层历史。
 *
 *  · 壳这一层(ShellNavigationHistory):对话 / 通讯录 / 任务之间,以及对话里选中哪条会话。
 *  · 会话页那一层:它自己的 NavigationHistoryStore(换任务、换页签),经 window 桥拿到。
 *
 * 在任务 tab 上时先走会话页那一层,走到头了才轮到壳 —— 与浏览器里「页内先退、退完再离开这一页」同一直觉,
 * 也与会话页自己的 ← 按钮、Mod+[ 走同一份栈,不会两边各记一份再对不上。
 *
 * location 为 null 表示这个装配不记历史(移动 shell 有自己的返回箭头与系统返回键)。
 */
export function useShellNavigation({
  location,
  reachable,
  apply,
}: {
  location: ShellLocation | null
  reachable: ShellLocationReachable
  apply: (location: ShellLocation) => void
}): ShellNavigation {
  const historyRef = useRef<ShellNavigationHistory | null>(null)
  if (historyRef.current === null) historyRef.current = new ShellNavigationHistory()
  const history = historyRef.current
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const sessionHistory = useSessionpageHistory()

  const key = location ? locationKey(location) : null
  const locationRef = useRef(location)
  locationRef.current = location
  useEffect(() => {
    const current = locationRef.current
    if (!current) return
    history.record(current)
    rerender()
  }, [history, key])

  const onSessions = location?.tab === 'tasks'
  const sessionCanGoBack = onSessions && sessionHistory !== null && sessionHistory.canGoBack()
  const sessionCanGoForward = onSessions && sessionHistory !== null && sessionHistory.canGoForward()
  const enabled = location !== null
  const canGoBack = enabled && (sessionCanGoBack || history.canGoBack(reachable))
  const canGoForward = enabled && (sessionCanGoForward || history.canGoForward(reachable))

  const goBack = useCallback(() => {
    if (sessionCanGoBack) {
      sessionHistory!.back()
      return
    }
    const target = history.back(reachable)
    if (target) apply(target)
    rerender()
  }, [apply, history, reachable, sessionCanGoBack, sessionHistory])

  const goForward = useCallback(() => {
    if (sessionCanGoForward) {
      sessionHistory!.forward()
      return
    }
    const target = history.forward(reachable)
    if (target) apply(target)
    rerender()
  }, [apply, history, reachable, sessionCanGoForward, sessionHistory])

  // Windows 上鼠标侧键就是后退 / 前进(资源管理器、浏览器都这样)。
  useEffect(() => {
    if (!enabled) return
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === MOUSE_BACK_BUTTON) {
        event.preventDefault()
        goBack()
      } else if (event.button === MOUSE_FORWARD_BUTTON) {
        event.preventDefault()
        goForward()
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [enabled, goBack, goForward])

  return { canGoBack, canGoForward, goBack, goForward }
}
