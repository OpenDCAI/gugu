import { useEffect, useRef } from 'react'

const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_CANCEL_PX = 10

/**
 * 触摸长按:按住 500ms 不动算长按,挪开 10px 以上作废。只认触摸 —— 它是手机上悬停 / 右键的替身;
 * 鼠标在桌面按住不动是划选文字的起手,❌ 当长按。
 * 长按成立后那一下松手 ❌ 再合成 click:面板 / 卡片正从手指底下长出来,那个 click 会把它当场关掉或点中某一行。
 * 成立那一刻轻震一下,和系统长按一样告诉手指「到了」(安卓壳在 manifest 里声明了 VIBRATE;没有振动器的环境里这一句什么也不做)。
 */
export function useLongPress(onLongPress: (at: { x: number; y: number }) => void) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])
  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }
  return {
    onPointerDown: (event: Pick<PointerEvent, 'pointerType' | 'clientX' | 'clientY'>) => {
      if (event.pointerType !== 'touch') return
      clear()
      firedRef.current = false
      const at = { x: event.clientX, y: event.clientY }
      startRef.current = at
      timerRef.current = window.setTimeout(() => {
        clear()
        firedRef.current = true
        navigator.vibrate?.(10)
        onLongPress(at)
      }, LONG_PRESS_MS)
    },
    onPointerMove: (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => {
      const at = startRef.current
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) >= LONG_PRESS_MOVE_CANCEL_PX) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onTouchEnd: (event: Pick<TouchEvent, 'preventDefault'>) => {
      if (firedRef.current) { firedRef.current = false; event.preventDefault() }
    },
  }
}
