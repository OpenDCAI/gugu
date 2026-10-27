import { FileText, Reply } from '@/lib/icons'
import { formatHotkeyText } from '@/session/renderer/lib/ui/shortcut-format'
import type { ContentContextMenu } from '@/session/shared/content-context-menu'
import { Menu, MenuItem, MenuSeparator } from './ui/Menu'

/** The same content-menu presentation for host actions and mobile file actions. */
export function ContentMenu({ menu, onClose, onAction }: {
  menu: ContentContextMenu
  onClose: () => void
  onAction: (id: string) => void
}) {
  return <Menu x={menu.x} y={menu.y} onClose={onClose}>
    {menu.items.map((item, index) => item.type === 'separator'
      ? <MenuSeparator key={index} />
      : <MenuItem key={item.id} disabled={item.enabled === false}
          icon={item.icon === 'quote' ? <Reply /> : item.icon === 'file' ? <FileText /> : undefined}
          shortcut={item.hotkey ? formatHotkeyText(item.hotkey) : undefined}
          onClick={() => onAction(item.id)}>{item.label}</MenuItem>)}
  </Menu>
}
