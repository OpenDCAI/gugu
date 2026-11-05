import { FileText, Reply } from '@/lib/icons'
import { formatHotkeyText } from '@/session/renderer/lib/ui/shortcut-format'
import type { RendererContentContextMenu } from '@/lib/contentContextMenu'
import { Menu, MenuItem, MenuSeparator } from './ui/Menu'
import { SelectedTextMenu } from './SelectedTextMenu'

/** The same content-menu presentation for host actions and mobile file actions. */
export function ContentMenu({ menu, onClose, onAction }: {
  menu: RendererContentContextMenu
  onClose: () => void
  onAction: (id: string) => void
}) {
  const copy = menu.items.find(item => item.type !== 'separator' && item.id === 'copy')
  if (menu.selectionRange && copy && copy.type !== 'separator') {
    return <SelectedTextMenu range={menu.selectionRange} item={copy} onClose={onClose} onCopy={() => onAction(copy.id)} />
  }
  return <Menu x={menu.x} y={menu.y} onClose={onClose}>
    {menu.items.map((item, index) => item.type === 'separator'
      ? <MenuSeparator key={index} />
      : <MenuItem key={item.id} disabled={item.enabled === false}
          icon={item.icon === 'quote' ? <Reply /> : item.icon === 'file' ? <FileText /> : undefined}
          shortcut={item.hotkey ? formatHotkeyText(item.hotkey) : undefined}
          onClick={() => onAction(item.id)}>{item.label}</MenuItem>)}
  </Menu>
}
