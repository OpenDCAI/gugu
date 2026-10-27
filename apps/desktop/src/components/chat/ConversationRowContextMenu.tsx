import { useTranslation } from 'react-i18next'
import { BellOff, CheckCircle, Pin, Trash } from '@/lib/icons'
import { Menu, MenuItem } from '../ui/Menu'
import type { ResourceContext } from '@/session/shared/resource-actions'
import { resourceMenuItems } from '@/lib/resourceActions'
import { conversationRowMenu, type ConversationRowAction, type ConversationRowMenuState } from '../../session/shared/conversation-row-menu'

const icons = { read: CheckCircle, pin: Pin, notifications: BellOff, trash: Trash }

export function ConversationRowContextMenu({ x, y, state, resource, onClose, onAction }: {
  x: number
  y: number
  state: ConversationRowMenuState
  resource?: ResourceContext
  onClose: () => void
  onAction: (action: ConversationRowAction) => void
}) {
  const { t } = useTranslation('messaging')
  return <Menu x={x} y={y} minWidth={160} onClose={onClose}>
    {resource && resourceMenuItems(resource).map(item => <MenuItem key={item.id} data-testid={`conversation-row-${item.id}`} onClick={() => { onClose(); void item.click() }}>{item.label}</MenuItem>)}
    {conversationRowMenu(state).map((item) => {
      const Icon = icons[item.icon]
      return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
        data-testid={item.id === 'mark-all-read' ? 'chat-row-mark-all-read' : `conversation-row-${item.id}`}
        onClick={() => { onClose(); onAction(item.id) }}>
        {t(`chatList.${item.label}`)}
      </MenuItem>
    })}
  </Menu>
}
