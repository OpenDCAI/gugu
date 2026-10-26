import { detectPlatform, matchesKeyboardEvent } from '@tanstack/react-hotkeys'
import { useCallback, useEffect, useState } from 'react'
import { FileText, Reply } from '@/lib/icons'
import { desktopIpc } from '@/platform/desktopIpc'
import { formatHotkeyText } from '@/session/renderer/lib/ui/shortcut-format'
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentContextMenu } from '@/session/shared/content-context-menu'
import { useToast } from './toastContext'
import { Menu, MenuItem, MenuSeparator } from './ui/Menu'

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

  if (!menu) return null
  return (
    <Menu key={menu.requestId} x={menu.x} y={menu.y} onClose={() => finish(menu.requestId)}>
      {menu.items.map((item, index) => item.type === 'separator'
        ? <MenuSeparator key={index} />
        : (
          <MenuItem
            key={item.id}
            disabled={item.enabled === false}
            icon={item.icon === 'quote' ? <Reply /> : item.icon === 'file' ? <FileText /> : undefined}
            shortcut={item.hotkey ? formatHotkeyText(item.hotkey) : undefined}
            onClick={() => finish(menu.requestId, item.id)}
          >
            {item.label}
          </MenuItem>
        ))}
    </Menu>
  )
}
