import { useCallback, useEffect, useState, useRef, type RefObject } from 'react'

import type { FlowListHandle } from '@/lib/flowList'
import type { HistoryWindow } from '@/store/chatHistoryWindow'
import { classifyFeedChange, type FeedItem } from './scrollControl'

/**
 * @@@6352 「读者在底部」是一个电平,不是一次事件。
 *
 * 列表的 onAtBottomChange 只在它自己的判断翻转时发一次。以前在这个回调里就地和
 * 「未读定位进行中 / 窗口之外还有更新 / 正在翻页」取与再写进窗口:回调那一刻只要有一道门挡着,
 * 这次读数就作废,门打开之后也没有第二次 —— 读者一直停在底部,列表不会再发。
 * 窗口于是一直以为读者在翻历史,下一条自己发的消息被当作跳出窗口:行被裁掉、回到最新页、
 * 整张列表重挂(owner 报的「发一条消息整个消息流闪一下」)。
 *
 * 所以这里只存电平,「跟随尾部」= 电平 ∧ 各道门都开着,任何一项变化都重算。
 * 电平按列表的 resetKey 归属:换会话 / 回到最新页时列表重挂并从 LAST 打开,
 * 在它报出第一次读数之前沿用「在底部」。
 */
export function useFollowingTail({
  resetKey,
  unreadNavigationPending,
  hasNewer,
  loading,
  isPreservingPosition,
  isAtBottomRef,
  setFollowingTail,
}: {
  resetKey: string
  unreadNavigationPending: boolean
  hasNewer: boolean
  loading: boolean
  isPreservingPosition: () => boolean
  isAtBottomRef: RefObject<boolean>
  setFollowingTail: (following: boolean) => void
}): { viewportAtBottom: boolean; onAtBottomChange: (atBottom: boolean) => void } {
  const [level, setLevel] = useState({ resetKey, atBottom: true })
  const viewportAtBottom = level.resetKey === resetKey ? level.atBottom : true
  // The level records every report, including those made while a saved position is restored: dropping
  // them left the level at its default and a later gate flip pinned a reader who was reading history.
  const onAtBottomChange = useCallback((atBottom: boolean) => setLevel({ resetKey, atBottom }), [resetKey])
  const following = viewportAtBottom && !unreadNavigationPending && !hasNewer && !loading
  useEffect(() => {
    // @@@sticky-pin (#667) - while a saved position is restored the restore owns following (it ends with
    // false itself); the list's at-bottom reading is transient in the meantime.
    if (isPreservingPosition()) return
    isAtBottomRef.current = following
    // @@@chat-window (#504) - tell the store whether we're pinned to the tail so it can trim the window.
    setFollowingTail(following)
  }, [following, isPreservingPosition, isAtBottomRef, setFollowingTail])
  return { viewportAtBottom, onAtBottomChange }
}

/** The main conversation's pin, resize and navigation policy, shared by every message surface. */
export function useTailPinning({ resetKey, messages, enabled, messageWindow, scrollerEl, scrollerRef, listRef,
  isAtBottomRef, isPreservingPosition, prepareForSavedPosition, forgetSavedPosition, returnToLatest, onError,
}: {
  resetKey: string
  messages: readonly FeedItem[]
  enabled: boolean
  messageWindow: Pick<HistoryWindow, 'hasNewer' | 'loading' | 'navigation' | 'navigationVersion'> | undefined
  scrollerEl: HTMLElement | null
  scrollerRef: RefObject<HTMLElement | null>
  listRef: RefObject<FlowListHandle | null>
  isAtBottomRef: RefObject<boolean>
  isPreservingPosition: () => boolean
  prepareForSavedPosition: () => boolean
  forgetSavedPosition: () => void
  returnToLatest: () => Promise<void>
  onError: (error: unknown) => void
}) {
  const fiResetChatRef = useRef<string | null>(null)
  const baselineRef = useRef(true)
  const lastTrackRef = useRef<{ firstId: string | null; lastId: string | null }>({ firstId: null, lastId: null })
  const lastNavigationRef = useRef(0)
  if (fiResetChatRef.current !== resetKey) {
    fiResetChatRef.current = resetKey
    baselineRef.current = true
  }

  const clampToTrueBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el || isPreservingPosition() || !isAtBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [scrollerRef, isPreservingPosition, isAtBottomRef])

  const pinToBottom = useCallback(() => {
    forgetSavedPosition()
    if (messageWindow?.hasNewer) { if (messageWindow.loading !== 'latest') void returnToLatest().catch(onError); return }
    isAtBottomRef.current = true
    listRef.current?.autoscrollToBottom()
    clampToTrueBottom()
  }, [listRef, clampToTrueBottom, messageWindow?.hasNewer, messageWindow?.loading, returnToLatest, onError, forgetSavedPosition, isAtBottomRef])

  useEffect(() => {
    const scroller = scrollerRef.current; if (!scroller) return
    let prevH = scroller.clientHeight
    const ro = new ResizeObserver(() => {
      const h = scroller.clientHeight
      if (h !== prevH) {
        prevH = h
        if (!isPreservingPosition() && isAtBottomRef.current) {
          listRef.current?.autoscrollToBottom()
          clampToTrueBottom()
        }
      }
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [scrollerEl, scrollerRef, clampToTrueBottom, isPreservingPosition, isAtBottomRef, listRef])

  useEffect(() => {
    if (!enabled) return
    const feed = messages
    const firstId = feed.length ? feed[0].id : null
    const lastId = feed.length ? feed[feed.length - 1].id : null
    if (baselineRef.current) {
      if (feed.length === 0) return
      baselineRef.current = false
      lastTrackRef.current = { firstId, lastId }
      lastNavigationRef.current = messageWindow?.navigationVersion ?? 0
      if (messageWindow?.navigation === 'anchor') return
      if (prepareForSavedPosition()) return
      pinToBottom()
      return
    }
    const navigated = lastNavigationRef.current !== (messageWindow?.navigationVersion ?? 0)
    lastNavigationRef.current = messageWindow?.navigationVersion ?? 0
    if (navigated && (messageWindow?.navigation === 'older' || messageWindow?.navigation === 'newer' || messageWindow?.navigation === 'anchor')) { lastTrackRef.current = { firstId, lastId }; return }
    if (navigated && messageWindow?.navigation === 'latest') { pinToBottom(); lastTrackRef.current = { firstId, lastId }; return }
    if (classifyFeedChange(lastTrackRef.current, feed, isAtBottomRef.current).pin) pinToBottom()
    lastTrackRef.current = { firstId, lastId }
  }, [messages, enabled, pinToBottom, prepareForSavedPosition, messageWindow?.navigationVersion, messageWindow?.navigation, isAtBottomRef])

  // Async row layout can grow the content without resizing the viewport. Preserve the main
  // window's geometry guard so a stale at-bottom report never pulls a reader away from history.
  const onTotalListHeightChanged = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current
      if (!el || isPreservingPosition() || !isAtBottomRef.current) return
      if (el.scrollHeight - el.clientHeight - el.scrollTop > 400) return
      el.scrollTop = el.scrollHeight
    })
  }, [scrollerRef, isPreservingPosition, isAtBottomRef])
  return { pinToBottom, onTotalListHeightChanged }
}
