import { useState, type RefObject } from 'react'
import { MoreHorizontal } from '@/lib/icons'
import { useTranslation } from 'react-i18next'
import { messageMenuModel, type MessageMenuCapabilities } from '@gugu/core/shared/ui/messageMenuModel'
import { Menu, MenuFold, MenuItem, type MenuAnchorProps } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { messageActionItems, type MessageActionItem, type MessageActionTarget } from './messageActionItems'
import { PhoneMessageMenu } from './PhoneMessageMenu'

/**
 * The hover menu, bubble context menu and phone long-press menu share message actions and quick reactions.
 * 桌面:指针处 / ⋯ 按钮下的菜单。手机长按(`lift`):同一份动作,换成「气泡浮起 + 旁边窄列表」那一层(PhoneMessageMenu)。
 */
export function MsgMoreMenu({ hasHoverBar, onReact, onClose, lift, isRetracted, content, hasSelection, onReply, onQuoteSelection, onCopy, onSelectText, onCopyLink, onOpenLink, onForward, onDownload, onKeep, onDelete, onSelect, onOpenTopic, ...anchor }: Partial<MenuAnchorProps> & MessageActionTarget & MessageMenuCapabilities & {
  onReact: (emoji: string) => void
  onClose: () => void
  /** 手机长按:被按的气泡、手指按下的高度;open=false 时播收起动画。 */
  lift?: { open: boolean; bubble: RefObject<HTMLElement | null>; touchY: number; mine: boolean }
}) {
  const { t } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const { showReactions } = messageMenuModel({ hasHoverBar })
  const items = messageActionItems({ isRetracted, content, hasSelection, onReply, onQuoteSelection, onCopy, onSelectText, onCopyLink, onOpenLink, onForward, onDownload, onKeep, onDelete, onSelect, onOpenTopic }, t)
  if (lift) {
    return <PhoneMessageMenu open={lift.open} bubble={lift.bubble} touchY={lift.touchY} mine={lift.mine} items={items}
      reactionsDisabled={isRetracted} onReact={onReact} onClose={onClose} />
  }
  const row = (item: MessageActionItem) => (
    <MenuItem key={item.key} icon={<item.icon size={15} />} disabled={item.disabled} danger={item.danger}
      data-testid={`message-action-${item.key}`}
      onClick={item.onSelect ? () => { item.onSelect?.(); onClose() } : undefined}>
      {item.label}
    </MenuItem>
  )
  return (
    <Menu {...(anchor as MenuAnchorProps)} minWidth={0} ariaLabel={t('message.actions.more')} onClose={onClose}>
      <div className={showReactions ? 'w-[min(358px,calc(100vw-24px))]' : 'min-w-40'} data-testid="message-action-menu">
        {showReactions && <DeferredEmojiQuickPicker menu disabled={isRetracted} onPick={onReact} onClose={onClose} onExpand={() => setExpanded(true)} />}
        {!expanded && <>
          {items.filter((item) => !item.fold).map(row)}
          <MenuFold icon={<MoreHorizontal size={15} />} label={t('message.actions.more')} data-testid="message-action-more">{items.filter((item) => item.fold).map(row)}</MenuFold>
        </>}
      </div>
    </Menu>
  )
}
