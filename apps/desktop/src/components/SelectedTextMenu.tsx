import { Popover } from '@base-ui/react/popover'
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { cn } from '@/lib/cn'
import type { ContentMenuItem } from '@/session/shared/content-context-menu'
import { menuRowClassName, menuRowLabelClassName, menuSurfaceClassName } from './ui/Menu'
import { useBackLayer } from './ui/sheetStack'

type Item = Exclude<ContentMenuItem, { type: 'separator' }>
const selectionGap = 12

/** Selection handles re-hit-test their fixed endpoint: never cover it or take its focus. */
export function SelectedTextMenu({ range, item, onClose, onCopy }: {
  range: Range
  item: Item
  onClose: () => void
  onCopy: () => void
}) {
  const container = useUiPortalContainer()
  const doc = range.startContainer.ownerDocument ?? document
  const scope = range.commonAncestorContainer
  const contextElement = scope.nodeType === Node.ELEMENT_NODE ? scope as Element : scope.parentElement
  const popup = useRef<HTMLDivElement>(null)
  const rangeAnchor = useCallback((selected: Range) => ({
    contextElement: contextElement ?? undefined,
    getBoundingClientRect: () => {
      const rect = selected.getBoundingClientRect()
      const view = doc.defaultView
      const top = view?.visualViewport?.offsetTop ?? 0
      const height = view?.visualViewport?.height ?? view?.innerHeight ?? 0
      const menuHeight = popup.current?.offsetHeight ?? 0
      if (rect.top - top >= menuHeight + selectionGap || top + height - rect.bottom >= menuHeight + selectionGap) return rect
      // A range spanning the viewport has no outside space. Its middle leaves both endpoints clear.
      return new DOMRect(rect.x, top + height / 2 + menuHeight / 2 + selectionGap, rect.width, 0)
    },
  }), [contextElement, doc])
  const [anchor, setAnchor] = useState(() => rangeAnchor(range))
  const close = useRef(onClose)
  close.current = onClose
  useBackLayer(onClose)

  useLayoutEffect(() => {
    const changed = () => {
      const selection = doc.getSelection()
      if (!scope.isConnected || !selection?.rangeCount || selection.isCollapsed
        || !selection.getRangeAt(0).intersectsNode(scope)) {
        close.current()
        return
      }
      const current = selection.getRangeAt(0).cloneRange()
      setAnchor(rangeAnchor(current))
    }
    doc.addEventListener('selectionchange', changed)
    return () => doc.removeEventListener('selectionchange', changed)
  }, [doc, rangeAnchor, scope])

  return <Popover.Root open modal={false} onOpenChange={open => { if (!open) onClose() }}>
    <Popover.Portal container={container}>
    <Popover.Positioner
      anchor={anchor} positionMethod="fixed" side="top" align="start" sideOffset={selectionGap}
      collisionPadding={8} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
      className="gg-menu-positioner window-no-drag-region z-[var(--z-menu)] outline-none"
    >
      <Popover.Popup ref={popup} role="menu" aria-label={item.label} initialFocus={false} finalFocus={false}
        data-occludes-browser-page className={cn(menuSurfaceClassName, 'min-w-40 p-[var(--gg-menu-padding,4px)]')}>
        <ButtonPrimitive role="menuitem" className={cn(menuRowClassName, 'p-[var(--gg-menu-item-padding,6px_10px)] [&:hover:not([data-disabled])]:bg-[var(--menu-item-hover)] [&:focus-visible:not([data-disabled])]:bg-[var(--menu-item-hover)]')}
          disabled={item.enabled === false}
          onPointerDown={event => event.preventDefault()} onClick={onCopy}>
          <span className={menuRowLabelClassName}>{item.label}</span>
        </ButtonPrimitive>
      </Popover.Popup>
    </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
