import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply } from '@/lib/icons'
import { MessageHoverTrigger } from './HoverActionBar'
import './chat-reply-quote.css'

export type ReplyQuoteDisclosure = { showMarker: boolean; open: boolean; mobile: boolean }

/** Keep the real quote mounted so pointer travel from the reply into its quote stays usable. */
export function ChatReplyQuote({ disclosure, onJump, children, insideBubble = false }: {
  disclosure: ReplyQuoteDisclosure
  insideBubble?: boolean
  onJump?: () => void
  children: ReactNode
}) {
  const { t } = useTranslation('messaging')
  const Root = disclosure.mobile || insideBubble ? 'div' : MessageHoverTrigger
  return (
    <Root className="gg-chat-reply-quote" data-chat-reply-quote data-open={disclosure.open} data-marker={disclosure.showMarker} data-mobile={disclosure.mobile}>
      <button type="button" className="gg-chat-reply-jump" aria-label={t('message.showQuoted')} title={t('message.showQuoted')}
        disabled={!onJump} onClick={(event) => { event.stopPropagation(); onJump?.() }}>
        <Reply className="size-3 shrink-0" aria-hidden />
      </button>
      <div className="gg-chat-reply-preview">{children}</div>
    </Root>
  )
}
