import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from '@/lib/icons'
import { Menu, MenuItem, type MenuAnchorProps } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { messageActionItems, type MessageActionTarget } from './messageActionItems'

/**
 * The hover menu, bubble context menu and phone long-press menu share message actions and quick reactions.
 * 手机长按贴着气泡弹出(owner 10-26 v7.12:❌ 底部抽屉);传了 selectableText 就多一项「选择文本」,
 * 在同一只浮层里换成可选中的原文,挑一段复制。
 */
export function MsgMoreMenu({ onReact, onClose, selectableText, isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onCopyLink, onOpenLink, onForward, onDownload, onDelete, onSelect, onOpenTopic, ...anchor }: MenuAnchorProps & MessageActionTarget & {
  onReact: (emoji: string) => void
  onClose: () => void
  selectableText?: string
}) {
  const { t } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)
  // 点「复制」那一下会先清掉选区:选区一变就记下原文里选中的那段。
  const picked = useRef('')
  useEffect(() => {
    if (!selecting) return
    const remember = () => {
      const selection = window.getSelection()
      const inside = !!selection && !!textRef.current?.contains(selection.anchorNode) && textRef.current.contains(selection.focusNode)
      if (inside && selection.toString()) picked.current = selection.toString()
    }
    document.addEventListener('selectionchange', remember)
    return () => document.removeEventListener('selectionchange', remember)
  }, [selecting])
  const target = { isMine, isRetracted, content, onReply, onQuoteSelection, onCopy, onCopyLink, onOpenLink, onForward, onDownload, onDelete, onSelect, onOpenTopic,
    onSelectText: selectableText && !isRetracted ? () => setSelecting(true) : undefined }
  const copyPicked = () => { onCopy?.(picked.current || window.getSelection()?.toString() || undefined); onClose() }
  return (
    <Menu {...anchor} minWidth={0} ariaLabel={t('message.actions.more')} onClose={onClose}>
      <div className="w-[min(358px,calc(100vw-24px))]" data-testid="message-action-menu">
        {selecting ? <>
          <div ref={textRef} data-testid="message-selection-text" aria-label={t('message.actions.selectText')}
            className="m-1 max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--input-bg)] p-2 select-text [-webkit-user-select:text]"
            onCopy={(event) => { const text = window.getSelection()?.toString(); if (text && onCopy) { event.preventDefault(); onCopy(text); onClose() } }}
          >{selectableText}</div>
          {onCopy ? <MenuItem icon={<Copy size={15} />} data-testid="message-action-copy" onClick={copyPicked}>{t('message.actions.copy')}</MenuItem> : null}
        </> : <>
          <DeferredEmojiQuickPicker menu disabled={isRetracted} onPick={onReact} onClose={onClose} onExpand={() => setExpanded(true)} />
          {!expanded && messageActionItems(target, t).map((item) => (
            <MenuItem key={item.key} icon={<item.icon size={15} />} disabled={item.disabled} danger={item.danger} title={item.title}
              data-testid={`message-action-${item.key}`} closeOnClick={!item.keepOpen}
              onClick={item.onSelect ? () => { item.onSelect?.(); if (!item.keepOpen) onClose() } : undefined}>
              {item.label}
            </MenuItem>
          ))}
        </>}
      </div>
    </Menu>
  )
}
