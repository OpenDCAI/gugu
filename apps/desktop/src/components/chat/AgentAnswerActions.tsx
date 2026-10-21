import { useTranslation } from 'react-i18next'
import { Copy, Reply, MoreHorizontal } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import type { RefObject } from 'react'

/** Settled agent answers expose their real actions without requiring hover discovery. */
export function AgentAnswerActions({ onCopy, onQuote, onMore, moreRef }: {
  onCopy: () => void; onQuote: () => void; onMore: () => void; moreRef: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation('messaging')
  return <div className="flex items-center gap-1 pt-1 text-[var(--text-tertiary)]" data-testid="agent-answer-actions">
    <IconButton size="sm" aria-label={t('message.actions.copy')} title={t('message.actions.copy')} onClick={onCopy}><Copy size={16} /></IconButton>
    <IconButton size="sm" aria-label={t('message.actions.reply')} title={t('message.actions.reply')} onClick={onQuote}><Reply size={16} /></IconButton>
    <IconButton ref={moreRef} size="sm" aria-label={t('message.actions.more')} title={t('message.actions.more')} onClick={onMore}><MoreHorizontal size={16} /></IconButton>
  </div>
}
