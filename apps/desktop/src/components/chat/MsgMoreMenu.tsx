import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { messageMenuModel, type MessageMenuCapabilities } from '@gugu/core/shared/ui/messageMenuModel'
import { Menu, MenuItem, type MenuAnchorProps } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { messageActionItems, type MessageActionTarget } from './messageActionItems'

/** The hover menu and bubble context menu share the same message menu model. */
export function MsgMoreMenu({ hasHoverBar, onReact, onClose, isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onCopyLink, onOpenLink, onForward, onDownload, onDelete, onSelect, onOpenTopic, ...anchor }: MenuAnchorProps & MessageActionTarget & MessageMenuCapabilities & {
  onReact: (emoji: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const { showReactions } = messageMenuModel({ hasHoverBar })
  const target = { isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onCopyLink, onOpenLink, onForward, onDownload, onDelete, onSelect, onOpenTopic }
  return (
    <Menu {...anchor} minWidth={0} ariaLabel={t('message.actions.more')} onClose={onClose}>
      <div className={showReactions ? 'w-[min(358px,calc(100vw-24px))]' : 'min-w-40'}>
        {showReactions && <DeferredEmojiQuickPicker menu disabled={isRetracted} onPick={onReact} onClose={onClose} onExpand={() => setExpanded(true)} />}
        {!expanded && messageActionItems(target, t).map((item) => (
          <MenuItem key={item.key} icon={<item.icon size={15} />} disabled={item.disabled} danger={item.danger} title={item.title}
            onClick={item.onSelect ? () => { item.onSelect?.(); onClose() } : undefined}>
            {item.label}
          </MenuItem>
        ))}
      </div>
    </Menu>
  )
}
