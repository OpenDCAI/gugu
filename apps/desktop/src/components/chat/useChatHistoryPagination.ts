import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { VIRTUOSO_START_INDEX } from './MessageList'
import type { HistoryWindow } from '../../store/chatHistoryWindow'
import { useHistoryPageAnchor } from './useHistoryPageAnchor'
import { afterPaint } from '../../lib/afterPaint'

export function useChatHistoryPagination({ resetKey, messages, enabled, scroller, atBottom, loadOlder, loadNewer, window, onError }: {
  resetKey: string
  messages: readonly Pick<MessageItem, 'id' | 'seq'>[]
  enabled: boolean
  scroller: HTMLElement | null
  /** The viewport's at-bottom level as the list reports it (MessageList onAtBottomChange). */
  atBottom: boolean
  loadOlder: () => Promise<void>
  loadNewer?: () => Promise<void>
  window?: HistoryWindow
  onError?: (error: unknown) => void
}): number {
  const [position, setPosition] = useState<{ resetKey: string; firstId: string | null; index: number }>({
    resetKey, firstId: messages[0]?.id ?? null, index: VIRTUOSO_START_INDEX,
  })
  const firstId = messages[0]?.id ?? null
  // The guard and index must commit together, including retries after a suspended
  // render. An effect commits new rows with old indices; a ref survives abandonment.
  if (position.resetKey !== resetKey) {
    setPosition({ resetKey, firstId: enabled ? firstId : null, index: VIRTUOSO_START_INDEX })
  } else if (enabled && firstId !== position.firstId) {
    const added = position.firstId ? messages.findIndex((message) => message.id === position.firstId) : 0
    setPosition({ resetKey, firstId, index: position.index - Math.max(0, added) })
  }

  // Persisted sequence numbers start at 1. Reaching that message exhausts history.
  const atBeginning = messages.some((message) => message.seq === 1)
  const { capture, cancel, isRestoring } = useHistoryPageAnchor({ resetKey, enabled, scroller, window, onError })
  const requestAtEdge = useCallback((edges: 'both' | 'bottom') => {
    if (!enabled || !scroller || window?.loading || isRestoring()) return
    const canLoadOlder = edges === 'both' && !atBeginning
    const canLoadNewer = !!window?.hasNewer && !!loadNewer
    // Tail updates invalidate this callback even when no newer page exists.
    // Decide whether either direction can act before reading layout dimensions.
    if (!canLoadOlder && !canLoadNewer) return
    if (scroller.scrollHeight - scroller.clientHeight <= 80) return
    const request = canLoadOlder && scroller.scrollTop <= 120 ? loadOlder
      : canLoadNewer && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 120 ? loadNewer : undefined
    if (request) {
      capture()
      void request().catch((error: unknown) => { cancel(); if (onError) onError(error); else throw error })
    }
  }, [enabled, scroller, atBeginning, loadOlder, loadNewer, window?.hasNewer, window?.loading, onError, capture, cancel, isRestoring])
  // The edge check waits for the paint; a re-render in between must not cancel it (see useConversationScrollMemory).
  const requestAtEdgeRef = useRef(requestAtEdge)
  requestAtEdgeRef.current = requestAtEdge
  useEffect(() => {
    if (!enabled || !scroller) return
    // startReached follows the overscanned render range and deduplicates its head.
    // Observe scrolling so an early rejected event cannot consume the physical top.
    // Do not invoke on mount: the initial tail jump has not completed at that point.
    const scrolled = afterPaint(() => requestAtEdgeRef.current('both'))
    scroller.addEventListener('scroll', scrolled.schedule, { passive: true })
    return () => { scroller.removeEventListener('scroll', scrolled.schedule); scrolled.cancel() }
  }, [enabled, scroller])
  // @@@6352 The bottom edge is a level, not only a scroll event: a fast scroll often stops outside the
  // threshold and reaches the bottom when the tail rows are measured and the list shrinks — no scroll
  // event follows. Without this the newer page is never requested and the window keeps treating a reader
  // sitting at the bottom as someone reading history.
  useEffect(() => {
    if (atBottom) requestAtEdge('bottom')
  }, [atBottom, requestAtEdge])
  return window?.firstItemIndex ?? position.index
}
