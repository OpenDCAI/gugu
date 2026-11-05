import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { cn } from '@/lib/cn'
import { Button } from '../ui/Button'
import { menuSurfaceClassName } from '../ui/Menu'
import { useBackLayer } from '../ui/sheetStack'

/**
 * 手机长按菜单里的「选择文本」:菜单收起,气泡本身变成可选(MessageBubble 这期间放开 user-select、不再拦长按),
 * 先替你选中整段正文,气泡上方一条「复制」。拖系统的选区把手改范围;点别处或按返回键结束。
 * 「复制」按下那一下会先清掉选区,所以选区一变就记下选中的那段。
 */
export function PhoneTextSelection({ bubble, onCopy, onDone }: {
  bubble: RefObject<HTMLElement | null>
  onCopy: (text: string) => void
  onDone: () => void
}) {
  const { t } = useTranslation('messaging')
  const portalContainer = useUiPortalContainer()
  const barRef = useRef<HTMLDivElement>(null)
  const picked = useRef('')
  const done = useRef(onDone)
  done.current = onDone
  const [at, setAt] = useState<{ top: number; left: number }>()
  useBackLayer(onDone)

  useLayoutEffect(() => {
    const el = bubble.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el.querySelector('.gg-md') ?? el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const r = el.getBoundingClientRect()
    setAt({ top: Math.max(8, r.top - 52), left: Math.max(8, r.left) })
    const remember = () => {
      const s = window.getSelection()
      if (s?.toString() && el.contains(s.anchorNode) && el.contains(s.focusNode)) picked.current = s.toString()
    }
    remember()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!el.contains(target) && !barRef.current?.contains(target)) done.current()
    }
    document.addEventListener('selectionchange', remember)
    document.addEventListener('pointerdown', outside, true)
    return () => {
      document.removeEventListener('selectionchange', remember)
      document.removeEventListener('pointerdown', outside, true)
      window.getSelection()?.removeAllRanges()
    }
  }, [bubble])

  return createPortal(
    <div ref={barRef} data-testid="message-selection-bar" className={cn(menuSurfaceClassName, 'fixed flex p-1')}
      style={{ top: at?.top, left: at?.left, zIndex: 'var(--z-menu)', visibility: at ? undefined : 'hidden' }}>
      <Button variant="ghost" size="sm" data-testid="message-selection-copy"
        onPointerDown={(event) => event.preventDefault()} onClick={() => onCopy(picked.current)}>
        {t('message.actions.copy')}
      </Button>
    </div>,
    portalContainer ?? document.body,
  )
}
