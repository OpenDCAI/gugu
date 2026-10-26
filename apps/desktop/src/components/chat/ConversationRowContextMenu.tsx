import { useTranslation } from 'react-i18next'
import { BellOff, CheckCircle, Pin, Trash } from '@/lib/icons'
import { Menu, MenuItem } from '../ui/Menu'
import { conversationRowMenu, type ConversationRowAction, type ConversationRowMenuState } from '../../session/shared/conversation-row-menu'

const icons = { read: CheckCircle, pin: Pin, notifications: BellOff, trash: Trash }

export function ConversationRowContextMenu({ x, y, state, onClose, onAction }: {
  x: number
  y: number
  state: ConversationRowMenuState
  onClose: () => void
  onAction: (action: ConversationRowAction) => void
}) {
  const { t } = useTranslation('messaging')
  return <Menu x={x} y={y} minWidth={160} onClose={onClose}>
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
