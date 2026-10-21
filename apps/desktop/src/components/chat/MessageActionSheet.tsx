import { useTranslation } from 'react-i18next'
import { EmojiQuickPicker } from './EmojiQuickPicker'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Reply } from '@/lib/icons'
import { messageActionItems, type MessageActionItem, type MessageActionTarget } from './messageActionItems'

type MessageActionSheetProps = MessageActionTarget & {
  onReact: (emoji: string) => void
  onReply: () => void
  onClose: () => void
}

/**
 * 手机上长按消息打开的动作面板:表情回应 + 回复(桌面在悬停条上,手机没有悬停)+ 与桌面菜单同一份动作。
 * 做成 Sheet:遮罩、Esc、安卓返回键都走它的关闭路径,会话页退走前它先被返回键关掉。
 */
export function MessageActionSheet({ onReact, onReply, onClose, ...target }: MessageActionSheetProps) {
  const { t } = useTranslation('messaging')
  const rows: MessageActionItem[] = [
    { key: 'reply', icon: Reply, label: t('message.actions.reply'), onSelect: onReply, disabled: target.isRetracted },
    ...messageActionItems(target, t),
  ]
  return (
    <Sheet onClose={onClose} mobileFitContent testId="message-action-sheet" ariaLabel={t('message.actions.more')}>
      <div className="px-3 pt-4 pb-3">
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
                onClick={item.onSelect}
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
