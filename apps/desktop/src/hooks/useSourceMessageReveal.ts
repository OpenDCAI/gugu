import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { FlowListHandle } from '../lib/flowList'
import { resolveSourceMessageScroll, type ScrollableRow } from '../lib/sourceMessageScroll'
import { UI_EVENTS } from '../lib/uiEvents'
import { revealSourceMessage, SOURCE_MESSAGE_FLASH_MS } from '../lib/sourceMessageReveal'

/** `gugu.showMessage` in a chat not on screen (MainLayout brings it up): the message its list goes to when it shows it. */
const askedReveals = new Map<string, string>()
export function askReveal(chatId: string, messageId: string, viewportKey = 'primary'): void {
  askedReveals.set(JSON.stringify([viewportKey, chatId]), messageId)
}
/** A task's view takes reveals under its own key in the same map: search asks, the task view takes it once on screen. */
const taskKey = (sessionId: string) => `task:${sessionId}`
export function askTaskReveal(sessionId: string, reference: string): void {
  askReveal(taskKey(sessionId), reference)
}
export function takeTaskReveal(sessionId: string): string | undefined {
  const asked = JSON.stringify(['primary', taskKey(sessionId)]), reference = askedReveals.get(asked)
  askedReveals.delete(asked)
  return reference
}

/**
 * #1708 来源消息 → 主消息列表定位 + 高亮闪烁。入口是群右栏工作区 App 的「来源消息」(gugu.showMessage;主进程已核过
 * 是本群的消息)。
 *
 * 已在加载段里的消息直接滚过去。不在的(文档的来源消息多半是早先的消息,早于当前加载段)交给会话滚动记忆的
 * revealMessage:它把这条消息当作要恢复的位置,按锚点把那一段载进来(loadMessageAnchor),列表重挂时就落在它上面,
 * 再核对到稳定 —— 一次性的 scrollToIndex 扛不住那次重挂。落稳了才闪。载不到(话题里的、已删的)或等不来 →
 * fail-loud(onMissing 出 toast),❌ 不静默 noop,也不滚去别处。
 */
export function useSourceMessageReveal(input: {
  activeChatId: string | null
  navigationTarget?: boolean
  viewportKey?: string
  enabled?: boolean
  ready?: boolean
  rows: ReadonlyArray<ScrollableRow>
  listRef: MutableRefObject<FlowListHandle | null>
  isAtBottomRef: MutableRefObject<boolean>
  setFollowingTail: (following: boolean) => void
  setFlashMessageId: (id: string | null) => void
  flashTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  revealMessage: (messageId: string) => Promise<void>
  onMissing: () => void
  onNavigate?: () => void
}): (messageId: string) => void {
  const { activeChatId, viewportKey, navigationTarget = false, enabled = true, ready = true, rows, listRef, isAtBottomRef, setFollowingTail, setFlashMessageId, flashTimerRef, revealMessage, onMissing } = input
  const onNavigateRef = useRef(input.onNavigate)
  onNavigateRef.current = input.onNavigate
  const tokenRef = useRef(0)
  const onMissingRef = useRef(onMissing)
  onMissingRef.current = onMissing

  const flash = useCallback((messageId: string) => {
    setFlashMessageId(messageId)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    // @@@state-ladder-mix 与 tokens.css 的 msg-src-flash 同步改到 spec 拍板的 1.4s(product spec);
    // 三处必须一起动(这里、tokens.css、hooks/useUnreadLocatorNavigation.ts 的未读定位),否则动画结束后类名还挂着。
    flashTimerRef.current = setTimeout(() => setFlashMessageId(null), SOURCE_MESSAGE_FLASH_MS)
  }, [flashTimerRef, setFlashMessageId])

  const reveal = useCallback((messageId: string) => {
    onNavigateRef.current?.()
    const token = ++tokenRef.current
    void revealSourceMessage(messageId, {
      showLoaded: (id) => {
        const index = resolveSourceMessageScroll(rows, id)
        if (index == null || !listRef.current) return false
        // #1980 Leave tail-following before a source-message jump.
        isAtBottomRef.current = false
        setFollowingTail(false)
        listRef.current.scrollToIndex({ index, align: 'center' })
        return true
      },
      load: revealMessage,
      flash,
      missing: () => onMissingRef.current(),
      current: () => tokenRef.current === token,
    })
  }, [flash, isAtBottomRef, listRef, revealMessage, rows, setFollowingTail])

  // 卸载时取消挂起的 flash 定时器(1.4s 内切 chat 会先卸载,避免 dangling timer)。定时器是和未读定位共用的那一个,
  // 这里一并清。
  useEffect(() => () => {
    tokenRef.current++
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [flashTimerRef])

  useEffect(() => {
    const takeAsked = () => {
      if (!activeChatId || !enabled) return
      const own = JSON.stringify([viewportKey, activeChatId]), primary = JSON.stringify(['primary', activeChatId])
      const key = askedReveals.has(own) ? own : navigationTarget ? primary : null
      const messageId = key ? askedReveals.get(key) : undefined
      if (!key || !messageId) return
      if (!ready) { onNavigateRef.current?.(); return }
      askedReveals.delete(key)
      reveal(messageId)
    }
    takeAsked()
    window.addEventListener(UI_EVENTS.chatAsked, takeAsked)
    return () => {
      window.removeEventListener(UI_EVENTS.chatAsked, takeAsked)
    }
  }, [activeChatId, enabled, ready, navigationTarget, viewportKey, reveal])
  const currentTarget = useRef(input)
  currentTarget.current = input
  return useCallback((messageId: string) => {
    const { activeChatId, viewportKey } = currentTarget.current
    if (!activeChatId) return
    askReveal(activeChatId, messageId, viewportKey)
    window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked))
  }, [])
}
