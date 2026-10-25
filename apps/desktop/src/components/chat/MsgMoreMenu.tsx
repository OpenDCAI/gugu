import { useTranslation } from 'react-i18next'
import { Menu, MenuItem, type MenuAnchorProps } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { messageActionItems, type MessageActionTarget } from './messageActionItems'

/** The hover menu and bubble context menu share message actions and quick reactions. */
export function MsgMoreMenu({ onReact, onClose, ...props }: MenuAnchorProps & MessageActionTarget & {
  onReact: (emoji: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  return (
    <Menu x={props.x} y={props.y} anchor={props.anchor} minWidth={0} style={{ width: 'min(366px, calc(100vw - 16px))' }} ariaLabel={t('message.actions.more')} onClose={onClose}>
      <DeferredEmojiQuickPicker menu disabled={props.isRetracted} onPick={onReact} onClose={onClose}>
        {messageActionItems(props, t).map((item) => (
          <MenuItem key={item.key} icon={<item.icon size={15} />} disabled={item.disabled} danger={item.danger} title={item.title}
            onClick={item.onSelect ? () => { item.onSelect?.(); onClose() } : undefined}>
            {item.label}
          </MenuItem>
        ))}
      </DeferredEmojiQuickPicker>
    </Menu>
  )
}
