import { useTranslation } from 'react-i18next'
import { BellOff, CheckCircle, MoreHorizontal, Pin, Trash } from '@/lib/icons'
import { Menu, MenuFold, MenuItem } from '../ui/Menu'
import { conversationRowMenu, type ConversationRowAction, type ConversationRowMenuState } from '../../session/shared/conversation-row-menu'

const icons = { read: CheckCircle, pin: Pin, notifications: BellOff, trash: Trash }

export function ConversationRowContextMenu({ x, y, state, onClose, onAction, loadError }: {
  x: number
  y: number
  loadError?: string | null
  state: ConversationRowMenuState
  onClose: () => void
  onAction: (action: ConversationRowAction) => void
}) {
  const { t } = useTranslation('messaging')
  const items = conversationRowMenu(state)
  const row = (item: (typeof items)[number]) => {
    const Icon = icons[item.icon]
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={item.id === 'mark-all-read' ? 'chat-row-mark-all-read' : `conversation-row-${item.id}`}
      onClick={() => { onClose(); onAction(item.id) }}>
      {t(`chatList.${item.label}`)}
    </MenuItem>
  }
  return <Menu x={x} y={y} minWidth={160} onClose={onClose}>
    {loadError ? <p role="alert" className="px-3 py-2 text-sm text-[var(--danger-fg)]">{loadError}</p> : null}
    {items.filter((item) => !item.fold).map(row)}
    <MenuFold icon={<MoreHorizontal size={15} />} label={t('message.actions.more')} data-testid="conversation-row-more">{items.filter((item) => item.fold).map(row)}</MenuFold>
  </Menu>
}
