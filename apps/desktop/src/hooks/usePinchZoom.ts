import { useEffect, useRef, type RefObject } from 'react'
import { isPinchWheel } from '@/session/shared/preview/pinch-zoom'

export interface PinchPoint {
  /** 指针相对元素可视区左上角的位置。 */
  x: number
  y: number
}

/**
 * 在一个元素上接触控板双指捏合(#6456;换算与原因见 `session/shared/preview/pinch-zoom.ts`)。
 *
 * · 只认带 `ctrlKey` 的 wheel:普通双指滑动照常滚动,不被吞掉。
 * · 监听必须是 `passive: false` —— React 的 `onWheel` 是 passive 的,`preventDefault` 无效。
 * · 一帧内的多次 wheel 攒成一次回调:捏合一秒能来几十个事件,每个都触发一次重排/重画,
 *   PDF 那种每次缩放都要重新渲染一页的,会一路取消上一次渲染、画面一直是空的。
 */
export function usePinchZoom(
  ref: RefObject<HTMLElement | null>,
  onPinch: (deltaY: number, point: PinchPoint) => void
): void {
  const onPinchRef = useRef(onPinch)
  useEffect(() => {
    onPinchRef.current = onPinch
  }, [onPinch])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let pendingDeltaY = 0
    let point: PinchPoint = { x: 0, y: 0 }
    let frame = 0

    const flush = () => {
      frame = 0
      const deltaY = pendingDeltaY
      pendingDeltaY = 0
      if (deltaY !== 0) onPinchRef.current(deltaY, point)
    }

    const onWheel = (event: WheelEvent) => {
      if (!isPinchWheel(event)) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      pendingDeltaY += event.deltaY
      if (!frame) frame = requestAnimationFrame(flush)
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref])
}
