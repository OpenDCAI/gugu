import { useTranslation } from 'react-i18next'
import { useRef } from 'react'
import { EmojiQuickPicker } from './EmojiQuickPicker'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { messageActionItems, type MessageActionTarget } from './messageActionItems'

type MessageActionSheetProps = MessageActionTarget & {
  onReact: (emoji: string) => void
  onReply: () => void
  onClose: () => void
  selectableText?: string
}

/**
 * 手机上长按消息打开的动作面板:表情回应 + 回复(桌面在悬停条上,手机没有悬停)+ 与桌面菜单同一份动作。
 * 做成 Sheet:遮罩、Esc、安卓返回键都走它的关闭路径,会话页退走前它先被返回键关掉。
 */
export function MessageActionSheet({ onReact, onClose, selectableText, ...target }: MessageActionSheetProps) {
  const { t } = useTranslation('messaging')
  const textRef = useRef<HTMLDivElement>(null)
  const selectedText = () => {
    const selection = window.getSelection()
    return selection && textRef.current?.contains(selection.anchorNode) && textRef.current.contains(selection.focusNode) ? selection.toString() : ''
  }
  const rows = messageActionItems({ ...target, onCopy: target.onCopy ? () => target.onCopy?.(selectedText() || undefined) : undefined }, t)
  return (
    <Sheet onClose={onClose} mobileFitContent testId="message-action-sheet" ariaLabel={t('message.actions.more')}>
      <div className="px-3 pt-4 pb-3">
        {selectableText && !target.isRetracted ? <>
          <div className="pb-1 text-xs text-[var(--text-secondary)]">{t('message.actions.selectText')}</div>
          <div ref={textRef} data-testid="message-selection-text" aria-label={t('message.actions.selectText')}
            className="mb-3 max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--input-bg)] p-3 select-text [-webkit-user-select:text]"
            onCopy={(event) => { const text = selectedText(); if (text && target.onCopy) { event.preventDefault(); target.onCopy(text) } }}
          >{selectableText}</div>
        </> : null}
        <EmojiQuickPicker onPick={onReact} onClose={onClose} disabled={target.isRetracted}>
          <div className="flex flex-col border-t border-[var(--border-subtle)] pt-2">
            {rows.map((item) => (
              <Button
                key={item.key}
                variant="ghost"
                data-testid={`message-action-${item.key}`}
                disabled={item.disabled}
                title={item.title}
                className={item.danger ? 'justify-start gap-3 text-[var(--menu-danger)]' : 'justify-start gap-3 text-[var(--text-primary)]'}
                onPointerDown={item.key === 'copy' ? (event) => event.preventDefault() : undefined}
                onClick={() => item.onSelect?.()}
              >
                <item.icon size={20} />
                {item.label}
              </Button>
            ))}
          </div>
        </EmojiQuickPicker>
      </div>
    </Sheet>
  )
}
