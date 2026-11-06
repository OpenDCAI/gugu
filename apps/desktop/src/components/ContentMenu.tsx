import { FileText, Reply } from '@/lib/icons'
import { formatHotkeyText } from '@/session/renderer/lib/ui/shortcut-format'
import type { RendererContentContextMenu } from '@/lib/contentContextMenu'
import type { ContentMenuItem } from '@/session/shared/content-context-menu'
import { Menu, MenuItem, MenuSeparator, MenuSubmenu } from './ui/Menu'
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
  const rows = (items: ContentMenuItem[]) => items.map((item, index) => {
    if (item.type === 'separator') return <MenuSeparator key={index} />
    const icon = item.icon === 'quote' ? <Reply /> : item.icon === 'file' ? <FileText /> : undefined
    if (item.items) return <MenuSubmenu key={item.id} icon={icon} label={item.label}>{rows(item.items)}</MenuSubmenu>
    return <MenuItem key={item.id} disabled={item.enabled === false} icon={icon}
      shortcut={item.hotkey ? formatHotkeyText(item.hotkey) : undefined}
      onClick={() => onAction(item.id)}>{item.label}</MenuItem>
  })
  return <Menu x={menu.x} y={menu.y} onClose={onClose}>{rows(menu.items)}</Menu>
}
