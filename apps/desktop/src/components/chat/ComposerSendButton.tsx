import { useTranslation } from 'react-i18next'
import { ArrowUp } from '@/lib/icons'
import { Button } from '../ui/Button'

/**
 * 聊天输入框的发送钮(框外右坞和格子里的底排同一个)。
 * @@@ui-ruler 发送钮 = ui/Button 的 primary 实底 + 药丸半径(--primary 与旧的 --accent 同值,
 * --primary-fg 与 --text-on-accent 同值 → 可发送态像素不变;尺寸 30 → --control-h-md 32、
 * 移动 44 由 size="icon" 自带)。手写的 onMouseEnter/onMouseLeave 改 style 那套 hover 删掉:
 * Button 自带 hover/press/disabled 三态。空态维持原来的「安静灰圆」而非淡掉的实底。
 */
export function ComposerSendButton({ sendable, mobile, onSend }: { sendable: boolean; mobile: boolean; onSend: () => void }) {
  const { t } = useTranslation('messaging')
  return (
    <Button
      variant="primary"
      size="icon"
      className="shrink-0 rounded-[var(--radius-capsule)] data-[disabled]:bg-[var(--muted)] data-[disabled]:text-[var(--faint-fg)]"
      onClick={onSend}
      disabled={!sendable}
      aria-label={t('common.send')}
      title={t('common.send')}
    >
      <ArrowUp size={mobile ? 18 : 16} />
    </Button>
  )
}
