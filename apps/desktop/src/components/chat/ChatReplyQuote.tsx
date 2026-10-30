import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import './chat-reply-quote.css'

export type ReplyQuoteDisclosure = { showMarker: boolean; mobile: boolean }

/** A reply target is disclosed only from its mark, never by hovering the whole message. */
export function ChatReplyQuote({ disclosure, onJump, children }: {
  disclosure: ReplyQuoteDisclosure
  onJump?: () => void
  children: ReactNode
}) {
  const { t } = useTranslation('messaging')
  if (!disclosure.showMarker) return null
  const mark = <IconButton size="sm" className="gg-chat-reply-jump" aria-label={t('message.showQuoted')}
    onClick={(event) => { event.stopPropagation(); if (!disclosure.mobile) onJump?.() }}>
    <Reply aria-hidden />
  </IconButton>
  const preview = <div className="gg-chat-reply-preview">{children}</div>
  return <div className="gg-chat-reply-quote" data-chat-reply-quote data-marker="true" data-mobile={disclosure.mobile}>
    {disclosure.mobile ? <Popover.Root modal={false}>
      <Popover.Trigger render={mark} />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup className="gg-chat-reply-popup p-2" data-chat-reply-preview-popup>
            {preview}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root> : <Tooltip.Root>
      <Tooltip.Trigger render={mark} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" align="start" sideOffset={6} collisionPadding={8}>
          <Tooltip.Popup className="gg-chat-reply-popup" data-chat-reply-preview-popup>{preview}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>}
  </div>
}
