import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hostCatalog } from '../../../shared/host-localization'
import { useLongPress } from '@/hooks/useLongPress'
import { useMobileShell } from '@/hooks/useMobileShell'
import { FALLBACK_LOCALE, matchSupportedLocale } from '@/i18n/locale'
import type { ContentMenuEntry } from '@/session/shared/content-context-menu'
import { FILE_VIEWER_ATTRIBUTE, FILE_VIEWER_MENU_EVENT, fileViewerMenuItems, type FileViewerMenuRequest } from '@/session/shared/preview/file-viewer-menu'
import { ContentMenu } from '../ContentMenu'
import { useToast } from '../toastContext'

type Viewer = { root: HTMLElement; id: string }
type MobileMenu = { requestId: string; x: number; y: number; items: ContentMenuEntry[] }
const viewerAt = (target: EventTarget | null): Viewer | null => {
  const root = target instanceof Element ? target.closest<HTMLElement>(`[${FILE_VIEWER_ATTRIBUTE}]`) : null
  const id = root?.getAttribute(FILE_VIEWER_ATTRIBUTE)
  return root && id ? { root, id } : null
}

/** Touch uses the same viewer snapshot and actions as desktop; opaque HTML stays behind its header. */
export function MobileFileContextMenu() {
  const mobile = useMobileShell()
  const { i18n } = useTranslation()
  const { toast } = useToast()
  const [menu, setMenu] = useState<MobileMenu | null>(null)
  const viewer = useRef<Viewer | null>(null)
  const longPress = useLongPress(at => {
    const captured = viewer.current
    if (!captured || !captured.root.isConnected || captured.root.getAttribute(FILE_VIEWER_ATTRIBUTE) !== captured.id) return
    const { root, id } = captured
    const selectionRoot = root.querySelector('[data-file-selection]') ?? root
    const selection = root.ownerDocument.getSelection()
    const text = selection?.anchorNode && selection.focusNode && selectionRoot.contains(selection.anchorNode) && selectionRoot.contains(selection.focusNode) ? selection.toString() : ''
    const context: FileViewerMenuRequest = { action: 'snapshot', requestId: crypto.randomUUID(), selection: { text }, canSelectAll: true }
    root.dispatchEvent(new CustomEvent(FILE_VIEWER_MENU_EVENT, { detail: context }))
    const labels = hostCatalog(matchSupportedLocale(i18n.resolvedLanguage) ?? FALLBACK_LOCALE).fileViewerMenu
    const run = async (action: Parameters<Parameters<typeof fileViewerMenuItems>[2]>[0]) => {
      // A different file may have replaced this viewer while the menu was open.
      if (!root.isConnected || root.getAttribute(FILE_VIEWER_ATTRIBUTE) !== id) return
      if (action === 'copy') return navigator.clipboard.writeText(context.selection.text)
      if (action === 'select-all' && !context.customSelectAll) {
        const range = root.ownerDocument.createRange()
        range.selectNodeContents(selectionRoot)
        const selected = root.ownerDocument.getSelection()
        selected?.removeAllRanges()
        selected?.addRange(range)
        return
      }
      root.dispatchEvent(new CustomEvent(FILE_VIEWER_MENU_EVENT, { detail: { ...context, action } }))
    }
    setMenu({ ...at, requestId: context.requestId, items: fileViewerMenuItems(context, labels, run) })
  })

  useEffect(() => {
    if (!mobile) return
    const down = (event: PointerEvent) => {
      viewer.current = viewerAt(event.target)
      if (viewer.current) longPress.onPointerDown(event)
    }
    const contextMenu = (event: Event) => { if (viewerAt(event.target)) event.preventDefault() }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointermove', longPress.onPointerMove, true)
    document.addEventListener('pointerup', longPress.onPointerUp, true)
    document.addEventListener('pointercancel', longPress.onPointerCancel, true)
    document.addEventListener('touchend', longPress.onTouchEnd, { capture: true, passive: false })
    document.addEventListener('contextmenu', contextMenu, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', longPress.onPointerMove, true)
      document.removeEventListener('pointerup', longPress.onPointerUp, true)
      document.removeEventListener('pointercancel', longPress.onPointerCancel, true)
      document.removeEventListener('touchend', longPress.onTouchEnd, true)
      document.removeEventListener('contextmenu', contextMenu, true)
    }
  }, [mobile, longPress])

  if (!mobile || !menu) return null
  return <ContentMenu key={menu.requestId} menu={menu} onClose={() => setMenu(null)} onAction={id => {
    const item = menu.items.find(item => item.type !== 'separator' && item.id === id)
    if (!item || item.type === 'separator' || item.enabled === false) return
    setMenu(null)
    void Promise.resolve().then(item.click).catch(error => toast(String(error), 'error'))
  }} />
}
