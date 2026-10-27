import { detectPlatform, matchesKeyboardEvent } from '@tanstack/react-hotkeys'
import { useCallback, useEffect, useState } from 'react'
import { desktopIpc } from '@/platform/desktopIpc'
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentContextMenu } from '@/session/shared/content-context-menu'
import { useToast } from './toastContext'
import { ContentMenu } from './ContentMenu'
import { MobileFileContextMenu } from './preview/MobileFileContextMenu'

/** Only presentation crosses into the renderer; the host retains the captured action closures. */
export function ContentContextMenuHost() {
  const [menu, setMenu] = useState<ContentContextMenu | null>(null)
  const { toast } = useToast()
  const finish = useCallback((requestId: string, actionId?: string) => {
    setMenu(current => current?.requestId === requestId ? null : current)
    void desktopIpc()?.invoke(CONTENT_CONTEXT_MENU_ACTION, { requestId, actionId })
      .catch(error => toast(String(error), 'error'))
  }, [toast])

  useEffect(() => desktopIpc()?.eventOn(CONTENT_CONTEXT_MENU_OPEN, data => {
    setMenu(data as ContentContextMenu)
  }), [])

  useEffect(() => {
    if (!menu) return
    const platform = detectPlatform()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const item = menu.items.find(item => item.type !== 'separator' && item.hotkey && matchesKeyboardEvent(event, item.hotkey, platform))
      if (!item || item.type === 'separator') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (item.enabled !== false) finish(menu.requestId, item.id)
    }
    window.addEventListener('keydown', keydown, true)
    const blur = () => finish(menu.requestId)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', blur)
      finish(menu.requestId)
    }
  }, [finish, menu])

  return <>
    {menu && <ContentMenu key={menu.requestId} menu={menu} onClose={() => finish(menu.requestId)} onAction={actionId => finish(menu.requestId, actionId)} />}
    <MobileFileContextMenu />
  </>
}
