import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { displayAgentReferences } from '@/lib/mentionMdast'
import { IconButton } from '../ui/IconButton'
import type { ChatMessageComposerProps } from './chatComposerModels'

export function ChatComposerContextBands({ quoteContent, onQuoteConsumed, whisperTarget, onExitWhisper }: ChatMessageComposerProps) {
  const { t } = useTranslation('messaging')
  return <>
    {whisperTarget && <div className="flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--bg-primary)] px-2 py-1">
      <span className="flex-1 text-[length:var(--font-caption)] text-[var(--faint-fg)]">{t('composer.whisperBanner', { name: whisperTarget.displayName })}</span>
      <IconButton size="sm" aria-label={t('composer.exitWhisper')} onClick={onExitWhisper}><X /></IconButton>
    </div>}
    {/* 回复条浮在消息流上,底只给它自己这张卡(owner 10-25)。 */}
    {quoteContent && <div className="mb-1.5 flex w-fit max-w-full shrink-0 items-center gap-2 rounded-[var(--radius-document)] bg-[var(--bg-elevated)] px-2 py-1 shadow-[var(--shadow-lift)]">
      <div className="h-6 w-1 shrink-0 rounded-[var(--radius-control)] bg-[var(--accent)]" />
      <div className="max-w-60 overflow-hidden py-1">
        {quoteContent.senderName && <div className="truncate text-[length:var(--font-body)] font-medium leading-[var(--lh-body)] text-[var(--accent)]">{quoteContent.senderName}</div>}
        <div className="truncate text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{displayAgentReferences(quoteContent.content, (_id, label) => `@${label}`)}</div>
      </div>
      <IconButton size="sm" aria-label={t('composer.cancelQuote')} onClick={onQuoteConsumed}><X /></IconButton>
    </div>}
  </>
}
