import { useCallback, useEffect, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { VIRTUOSO_START_INDEX } from './MessageList'
import type { HistoryWindow } from '../../store/chatHistoryWindow'
import { useHistoryPageAnchor } from './useHistoryPageAnchor'

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
    if (!enabled || !scroller) return
    // At the bottom the only page there can be is a newer one: without it, read no geometry (scrollHeight forces a
    // layout of the whole page, and this runs on every render while the reader sits at the bottom).
    if (edges === 'bottom' && !window?.hasNewer) return
    if (scroller.scrollHeight - scroller.clientHeight <= 80 || window?.loading || isRestoring()) return
    const request = edges === 'both' && !atBeginning && scroller.scrollTop <= 120 ? loadOlder
      : window?.hasNewer && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 120 ? loadNewer : undefined
    if (request) {
      capture()
      void request().catch((error: unknown) => { cancel(); if (onError) onError(error); else throw error })
    }
  }, [enabled, scroller, atBeginning, loadOlder, loadNewer, window?.hasNewer, window?.loading, onError, capture, cancel, isRestoring])
  useEffect(() => {
    if (!enabled || !scroller) return
    // startReached follows the overscanned render range and deduplicates its head.
    // Observe scrolling so an early rejected event cannot consume the physical top.
    // Do not invoke on mount: the initial tail jump has not completed at that point.
    const onScroll = () => requestAtEdge('both')
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [enabled, scroller, requestAtEdge])
  // @@@6352 The bottom edge is a level, not only a scroll event: a fast scroll often stops outside the
  // threshold and reaches the bottom when the tail rows are measured and the list shrinks — no scroll
  // event follows. Without this the newer page is never requested and the window keeps treating a reader
  // sitting at the bottom as someone reading history.
  useEffect(() => {
    if (atBottom) requestAtEdge('bottom')
  }, [atBottom, requestAtEdge])
  return window?.firstItemIndex ?? position.index
}
