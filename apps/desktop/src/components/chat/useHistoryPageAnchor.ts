import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { HistoryWindow } from '../../store/chatHistoryWindow'

type Anchor = { id: string; top: number; version: number; resetKey: string }

/** A virtual index preserves identity; sliding a measured variable-height window also needs its pixel offset. */
export function useHistoryPageAnchor({ resetKey, enabled, scroller, window, onError }: {
  resetKey: string
  enabled: boolean
  scroller: HTMLElement | null
  window?: HistoryWindow
  onError?: (error: unknown) => void
}) {
  const pending = useRef<Anchor | null>(null)
  const restoring = useRef(false)
  const isRestoring = useCallback(() => restoring.current, [])
  const cancel = useCallback(() => { pending.current = null; restoring.current = false }, [])
  const capture = useCallback(() => {
    if (!scroller || !window) return
    const bounds = scroller.getBoundingClientRect()
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-msg-id]')]
    // The old first row may lose its date/sender header when predecessors arrive.
    const row = rows.find((item) => item.getAttribute('aria-posinset') !== '1'
      && item.getBoundingClientRect().top >= bounds.top && item.getBoundingClientRect().bottom <= bounds.bottom)
      ?? rows.find((item) => item.getBoundingClientRect().bottom > bounds.top && item.getBoundingClientRect().top < bounds.bottom)
    pending.current = row?.dataset.msgId
      ? { id: row.dataset.msgId, top: row.getBoundingClientRect().top - bounds.top, version: window.navigationVersion, resetKey }
      : null
  }, [resetKey, scroller, window])

  useEffect(() => {
    cancel()
    if (!scroller) return
    // User input takes precedence over an in-progress automatic restoration.
    const interrupt = () => { if (pending.current) cancel() }
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchstart', interrupt, { passive: true })
    scroller.addEventListener('pointerdown', interrupt, { passive: true })
    return () => {
      cancel()
      scroller.removeEventListener('wheel', interrupt)
      scroller.removeEventListener('touchstart', interrupt)
      scroller.removeEventListener('pointerdown', interrupt)
    }
  }, [resetKey, scroller, enabled, cancel])

  useLayoutEffect(() => {
    const anchor = pending.current
    if (!enabled || !scroller || !window || !anchor || anchor.version === window.navigationVersion) return
    if (anchor.resetKey !== resetKey || (window.navigation !== 'older' && window.navigation !== 'newer')) { cancel(); return }
    if (!window.messages.some((row) => row.id === anchor.id)) { cancel(); return }
    restoring.current = true
    let frame = 0
    let stable = 0
    const started = performance.now()
    const settle = (now: number) => {
      if (pending.current !== anchor) return
      const row = [...scroller.querySelectorAll<HTMLElement>('[data-msg-id]')].find((item) => item.dataset.msgId === anchor.id)
      if (row) {
        const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top
        if (Math.abs(delta) <= 1) stable += 1
        else { stable = 0; scroller.scrollTop += delta }
        if (stable >= 3 && now - started >= 100) { cancel(); return }
      }
      if (now - started >= 1_000) {
        cancel()
        onError?.(new Error('History page could not preserve the visible message position'))
        return
      }
      frame = requestAnimationFrame(settle)
    }
    // 第一次纠正就在这次提交里做(布局之后、绘制之前):推到下一帧,接进来的那页先把视口顶走一帧再拉回 = 抽一下(#6595)。
    settle(performance.now())
    return () => { cancelAnimationFrame(frame); restoring.current = false }
  }, [enabled, resetKey, scroller, window, onError, cancel])

  return { capture, cancel, isRestoring }
}
