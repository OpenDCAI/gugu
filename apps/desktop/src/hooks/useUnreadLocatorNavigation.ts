import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { FlowListHandle } from '../lib/flowList'
import { UI_EVENTS } from '../lib/uiEvents'
import { resolveSourceMessageScroll, type ScrollableRow } from '../lib/sourceMessageScroll'
import type { UnreadLocatorCommit } from '../lib/chatUnreadLocatorWindow'
import type { UnreadMessageRevealRequest } from '../lib/chatUnreadLocator'

function isVisibleWithinSurface(row: HTMLElement, surface: HTMLElement): boolean {
  if (!row.isConnected || !surface.isConnected || row.getClientRects().length === 0 || surface.getClientRects().length === 0) return false
  const rowStyle = window.getComputedStyle(row)
  const surfaceStyle = window.getComputedStyle(surface)
  if (rowStyle.display === 'none' || rowStyle.visibility === 'hidden'
    || surfaceStyle.display === 'none' || surfaceStyle.visibility === 'hidden'
    || Number.parseFloat(surfaceStyle.opacity || '1') < 0.99) return false
  const rowRect = row.getBoundingClientRect()
  const surfaceRect = surface.getBoundingClientRect()
  return rowRect.width > 0 && rowRect.height > 0
    && rowRect.bottom > surfaceRect.top && rowRect.top < surfaceRect.bottom
    && rowRect.right > surfaceRect.left && rowRect.left < surfaceRect.right
}

export function findVisibleUnreadMessageRow(
  surface: HTMLElement | null,
  messageId: string,
): HTMLElement | null {
  if (!surface) return null
  const row = Array.from(surface.querySelectorAll<HTMLElement>('[data-msg-id]'))
    .find((element) => element.dataset.msgId === messageId)
  return row && isVisibleWithinSurface(row, surface) ? row : null
}

export function useUnreadLocatorNavigation(input: {
  activeChatId: string | null
  navigationTarget?: boolean
  enabled?: boolean
  onNavigate?: () => void
  rows: ReadonlyArray<ScrollableRow & { message?: { id: string; seq: number } }>
  firstItemIndex: number
  scrollerRef: RefObject<HTMLElement | null>
  listRef: MutableRefObject<FlowListHandle | null>
  setFollowingTail: (following: boolean) => void
  setFlashMessageId: (id: string | null) => void
  flashTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  hasMoreOlder: boolean
  loadingOlder: boolean
  loadOlderMessages: () => Promise<void>
  hasMoreNewer?: boolean
  loadingNewer?: boolean
  loadNewerMessages?: () => Promise<void>
  loadMessageAnchor?: (messageId: string, commit?: UnreadLocatorCommit) => Promise<void>
}): void {
  const {
    activeChatId, navigationTarget = false, enabled = true, onNavigate,
    rows,
    firstItemIndex,
    listRef, scrollerRef,
    setFollowingTail,
    setFlashMessageId,
    flashTimerRef,
    hasMoreOlder,
    loadingOlder,
    loadOlderMessages,
    hasMoreNewer = false,
    loadingNewer = false,
    loadNewerMessages, loadMessageAnchor,
  } = input
  const [pending, setPending] = useState<UnreadMessageRevealRequest | null>(null)
  const openedThreadTokenRef = useRef<string | null>(null)

  useEffect(() => {
    const onUnreadMessage = (event: Event) => {
      const detail = (event as CustomEvent<Partial<UnreadMessageRevealRequest>>).detail
      if (detail?.chatId !== activeChatId) return
      const target = detail.viewport ?? 'primary'
      if (target === 'primary' ? !navigationTarget : target !== scrollerRef.current) return
      if (!detail || typeof detail.chatId !== 'string' || typeof detail.streamId !== 'string'
        || (detail.streamKind !== 'main' && detail.streamKind !== 'thread')
        || typeof detail.messageId !== 'string' || typeof detail.messageSeq !== 'number'
        || typeof detail.token !== 'string' || typeof detail.confirm !== 'function' || typeof detail.reject !== 'function') return
      onNavigate?.()
      const activate = () => setPending((previous) => {
        if (previous && previous.token !== detail.token) previous.reject(new Error('Unread navigation was superseded'))
        return detail as UnreadMessageRevealRequest
      })
      if (detail.commit && loadMessageAnchor) void loadMessageAnchor(detail.messageId, detail.commit).then(activate, detail.reject)
      else activate()
    }
    window.addEventListener(UI_EVENTS.openUnreadMessage, onUnreadMessage)
    return () => window.removeEventListener(UI_EVENTS.openUnreadMessage, onUnreadMessage)
  }, [activeChatId, scrollerRef, navigationTarget, onNavigate, loadMessageAnchor])

  useEffect(() => {
    if (!pending || !enabled) return
    const reject = (error: unknown) => {
      pending.reject(error)
      setPending((current) => current?.token === pending.token ? null : current)
    }
    if (pending.isCurrent && !pending.isCurrent()) {
      reject(new DOMException('Unread navigation was superseded', 'AbortError'))
      return
    }
    if (pending.chatId !== activeChatId) {
      pending.reject(new Error(`Unread navigation left chat ${pending.chatId}`))
      setPending(null)
      return
    }
    // @@@5856 thread 流已随群 thread 面板退役:话题是另一条 chat,它的未读走那条 chat 自己的定位器。
    // 残留的 thread 定位器(老数据)在这里显形为「打不开的目标」,❌ 不静默吞 —— 直接不处理并让它过期。
    if (pending.streamKind === 'thread' && openedThreadTokenRef.current !== pending.token) {
      openedThreadTokenRef.current = pending.token
    }
    const index = pending.streamKind === 'main'
      ? resolveSourceMessageScroll(rows, pending.messageId)
      : -1
    if (index == null || index < 0) {
      if (loadingOlder || loadingNewer) return
      const seqs = rows.flatMap((row) => row.type === 'message' && row.message && row.message.seq > 0 ? [row.message.seq] : [])
      const load = pending.streamKind !== 'main' || seqs.length === 0 ? undefined
        : pending.messageSeq < Math.min(...seqs) && hasMoreOlder ? loadOlderMessages
          : pending.messageSeq > Math.max(...seqs) && hasMoreNewer ? loadNewerMessages : undefined
      if (load) void load().catch(reject)
      else reject(new Error(`Unread locator ${pending.messageId} is not loaded in ${pending.streamId}`))
      return
    }
    if (pending.streamKind === 'main') {
      setFollowingTail(false)
      listRef.current?.scrollToIndex({ index, align: 'center' })
    }
    setFlashMessageId(pending.messageId)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    // @@@state-ladder-mix 与 tokens.css 的 msg-src-flash 动画时长同步(spec 拍板 1.4s,
    // product spec)。这是**第三处**:tokens.css 的 animation、
    // hooks/useSourceMessageReveal.ts 的来源消息定位、这里的未读定位,三处必须一起动。
    // 挂久了不只是留个死类名——类名还在时对同一条消息再次定位,CSS 动画不会重启,
    // 连点两次「跳到未读」第二次就没有任何闪烁反馈。
    flashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1400)

    let frame = 0
    const startedAt = performance.now()
    const confirmRendered = () => {
      if (pending.isCurrent && !pending.isCurrent()) {
        reject(new DOMException('Unread navigation was superseded', 'AbortError'))
        return true
      }
      const row = findVisibleUnreadMessageRow(scrollerRef.current, pending.messageId)
      if (!row) return false
      if (pending.streamKind === 'thread') row.scrollIntoView({ block: 'center' })
      pending.confirm(pending.messageId)
      setPending((current) => current?.token === pending.token ? null : current)
      return true
    }
    const pollRendered = () => {
      if (confirmRendered()) return
      if (performance.now() - startedAt >= 5000) {
        pending.reject(new Error(`Unread locator ${pending.messageId} did not become visible in ${pending.streamId}`))
        setPending((current) => current?.token === pending.token ? null : current)
        return
      }
      frame = window.requestAnimationFrame(pollRendered)
    }
    frame = window.requestAnimationFrame(pollRendered)
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeChatId, enabled, firstItemIndex, flashTimerRef, hasMoreOlder, loadOlderMessages, loadingOlder, hasMoreNewer, loadNewerMessages, loadingNewer,
    pending, rows, setFlashMessageId, setFollowingTail, listRef, scrollerRef])
}
