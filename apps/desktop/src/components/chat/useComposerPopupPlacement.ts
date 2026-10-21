import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import getCaretCoordinates from 'textarea-caret'
import { placeComposerPopup } from './composerPopupPlacement'

/**
 * @ / 斜杠候选框的落点:贴着触发字符那一行、左对齐那个字符(2a)。
 * layoutKey 只在候选框开着时变化 —— 关着时不因每个按键跑 effect(#6200:一次按键只许一次提交)。
 */
export function useComposerPopupPlacement(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  triggerIndex: number | null,
  layoutKey: string | null,
) {
  const rootRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ left: number; bottom: number } | null>(null)
  const placementRef = useRef(placement)
  placementRef.current = placement
  useLayoutEffect(() => {
    const ta = textareaRef.current
    const root = rootRef.current
    if (triggerIndex === null || !ta || !root) {
      if (placementRef.current !== null) setPlacement(null)
      return
    }
    const caret = getCaretCoordinates(ta, triggerIndex)
    const taRect = ta.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const next = placeComposerPopup({
      caret,
      textareaOffset: { left: taRect.left - rootRect.left, top: taRect.top - rootRect.top },
      scroll: { left: ta.scrollLeft, top: ta.scrollTop },
      containerWidth: rootRect.width,
      containerHeight: rootRect.height,
      popupWidth: popupRef.current?.offsetWidth ?? 0,
    })
    const prev = placementRef.current
    if (!prev || prev.left !== next.left || prev.bottom !== next.bottom) setPlacement(next)
  }, [textareaRef, triggerIndex, layoutKey])
  const position: CSSProperties = placement
    ? { left: placement.left, bottom: placement.bottom }
    : { left: 8, bottom: '100%', marginBottom: 6 }
  return { rootRef, popupRef, position }
}
