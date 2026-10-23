import { useCallback, useEffect, useRef, type PointerEvent } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { useMobileShell } from '@/hooks/useMobileShell'
import './phone-sheet-handle.css'

interface Drag {
  id: number
  x: number
  y: number
  distance: number
  popup: HTMLElement
}

/** Drag only the handle: scrolling a form must never dismiss it or discard its draft. */
export function PhoneSheetHandle({ onDismiss, disabled = false }: { onDismiss: () => void; disabled?: boolean }) {
  const mobile = useMobileShell()
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const reset = useCallback(() => {
    const current = drag.current
    if (current) {
      current.popup.style.removeProperty('translate')
      current.popup.style.removeProperty('transition')
    }
    drag.current = null
  }, [])
  useEffect(() => {
    if (disabled || !mobile) reset()
    return reset
  }, [disabled, mobile, reset])

  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || !event.isPrimary || drag.current) return
    suppressClick.current = false
    if (event.pointerType === 'mouse') return
    const popup = event.currentTarget.closest<HTMLElement>('[role="dialog"]')
    if (!popup) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, popup }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x, dy = event.clientY - current.y
    if (Math.hypot(dx, dy) > 8) suppressClick.current = true
    current.distance = dy > Math.abs(dx) ? dy : 0
    current.popup.style.setProperty('transition', 'none')
    current.popup.style.setProperty('translate', `0 ${Math.min(current.distance, current.popup.getBoundingClientRect().height)}px`)
  }
  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const threshold = Math.max(64, Math.min(120, current.popup.getBoundingClientRect().height / 4))
    const dismiss = !cancelled && !disabled && current.distance >= threshold
    if (cancelled || dismiss) suppressClick.current = true
    reset()
    if (dismiss) onDismiss()
  }
  if (!mobile) return null
  return (
    <IconButton
      size="lg" className="gg-phone-sheet-drag-handle" aria-label="关闭面板" disabled={disabled}
      onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
      onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) { event.preventDefault(); return }
        onDismiss()
      }}
    ><span aria-hidden="true" /></IconButton>
  )
}
