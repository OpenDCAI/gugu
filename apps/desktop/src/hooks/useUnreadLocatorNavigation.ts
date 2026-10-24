import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { UI_EVENTS } from '../lib/uiEvents'
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

/** Unread navigation uses the same pre-paint anchor landing as source-message navigation. */
export function useUnreadLocatorNavigation(input: {
  activeChatId: string | null
  navigationTarget?: boolean
  enabled?: boolean
  onNavigate?: () => void
  scrollerRef: RefObject<HTMLElement | null>
  revealMessage: (messageId: string, commit?: UnreadLocatorCommit) => Promise<void>
  setFlashMessageId: (id: string | null) => void
  flashTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
}): boolean {
  const { activeChatId, navigationTarget = false, enabled = true, onNavigate, scrollerRef,
    revealMessage, setFlashMessageId, flashTimerRef } = input
  const [pending, setPending] = useState<UnreadMessageRevealRequest | null>(null)
  const started = useRef<UnreadMessageRevealRequest | null>(null)
  const currentChat = useRef(activeChatId)
  currentChat.current = activeChatId

  useEffect(() => {
    const onUnreadMessage = (event: Event) => {
      const detail = (event as CustomEvent<Partial<UnreadMessageRevealRequest>>).detail
      if (detail?.chatId !== activeChatId) return
      const target = detail.viewport ?? 'primary'
      if (target === 'primary' ? !navigationTarget : target !== scrollerRef.current) return
      if (typeof detail.chatId !== 'string' || typeof detail.streamId !== 'string'
        || (detail.streamKind !== 'main' && detail.streamKind !== 'thread')
        || typeof detail.messageId !== 'string' || typeof detail.messageSeq !== 'number'
        || typeof detail.token !== 'string' || typeof detail.confirm !== 'function' || typeof detail.reject !== 'function') return
      onNavigate?.()
      setPending((previous) => {
        if (previous && previous.token !== detail.token) previous.reject(new Error('Unread navigation was superseded'))
        return detail as UnreadMessageRevealRequest
      })
    }
    window.addEventListener(UI_EVENTS.openUnreadMessage, onUnreadMessage)
    return () => window.removeEventListener(UI_EVENTS.openUnreadMessage, onUnreadMessage)
  }, [activeChatId, scrollerRef, navigationTarget, onNavigate])

  useEffect(() => {
    if (!pending || !enabled || started.current === pending) return
    const finish = (error?: unknown) => {
      if (error !== undefined) pending.reject(error)
      else pending.confirm(pending.messageId)
      setPending((current) => current === pending ? null : current)
    }
    if (pending.chatId !== activeChatId || (pending.isCurrent && !pending.isCurrent())) {
      finish(new DOMException('Unread navigation was superseded', 'AbortError'))
      return
    }
    if (pending.streamKind !== 'main') {
      finish(new Error('Unread thread ' + pending.streamId + ' is no longer available'))
      return
    }
    started.current = pending
    // Establish the target before replacing its window. openLocation hides an absent anchor and the
    // remounted MessageList lands on it in layout, instead of first painting the window's tail.
    void revealMessage(pending.messageId, pending.commit).then(() => {
      if (currentChat.current !== pending.chatId || (pending.isCurrent && !pending.isCurrent())) {
        finish(new DOMException('Unread navigation was superseded', 'AbortError'))
        return
      }
      if (!findVisibleUnreadMessageRow(scrollerRef.current, pending.messageId)) {
        finish(new Error('Unread locator ' + pending.messageId + ' is not visible in ' + pending.streamId))
        return
      }
      setFlashMessageId(pending.messageId)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      // Keep in sync with tokens.css and useSourceMessageReveal's existing highlight duration.
      flashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1400)
      finish()
    }, finish)
  }, [activeChatId, enabled, pending, revealMessage, scrollerRef, setFlashMessageId, flashTimerRef])
  return pending !== null && pending.chatId === activeChatId
}
