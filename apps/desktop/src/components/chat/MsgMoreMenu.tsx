import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, MenuItem, type MenuAnchorProps } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { messageActionItems, type MessageActionTarget } from './messageActionItems'

/** The hover menu and bubble context menu share message actions and quick reactions. */
export function MsgMoreMenu({ onReact, onClose, isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onForward, onDownload, onDelete, onSelect, onOpenTopic, ...anchor }: MenuAnchorProps & MessageActionTarget & {
  onReact: (emoji: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const target = { isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onForward, onDownload, onDelete, onSelect, onOpenTopic }
  return (
    <Menu {...anchor} minWidth={0} style={{ width: 'min(366px, calc(100vw - 16px))' }} ariaLabel={t('message.actions.more')} onClose={onClose}>
      <DeferredEmojiQuickPicker menu disabled={isRetracted} onPick={onReact} onClose={onClose} onExpand={() => setExpanded(true)} />
      {!expanded && messageActionItems(target, t).map((item) => (
          <MenuItem key={item.key} icon={<item.icon size={15} />} disabled={item.disabled} danger={item.danger} title={item.title}
            onClick={item.onSelect ? () => { item.onSelect?.(); onClose() } : undefined}>
            {item.label}
          </MenuItem>
      ))}
    </Menu>
  )
}
