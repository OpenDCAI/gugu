import { useCallback, useRef, useState, type SetStateAction } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { composerCardLine } from '../lib/composerCardCopy'
import type { ChatMessageComposerProps } from '../components/chat/chatComposerModels'
import type { QuoteSelection } from '../components/chat/messageQuoteContent'

type Quote = NonNullable<ChatMessageComposerProps['quoteContent']>

/** Every conversation surface preserves the same selection intent, source and cancellation token. */
export function useMessageQuote(chatId: string | null, senderNameOf: (id: string | null) => string, attachmentLabel: string) {
  const [stored, setStored] = useState<{ chatId: string | null; quote: Quote } | null>(null)
  const latest = useRef({ senderNameOf, attachmentLabel })
  latest.current = { senderNameOf, attachmentLabel }
  const setQuote = useCallback((next: SetStateAction<Quote | null | undefined>) => {
    setStored(previous => {
      const current = previous?.chatId === chatId ? previous.quote : null
      const quote = typeof next === 'function' ? next(current) : next
      if (quote === current) return previous
      return quote ? { chatId, quote } : null
    })
  }, [chatId])
  const onQuote = useCallback((msg: MessageItem, selection?: QuoteSelection) => {
    setQuote(current => {
      if (selection?.clear) return selection.selectionId && current?.selectionId === selection.selectionId ? null : current
      const textSelection = msg.content_type === 'text' ? selection : undefined
      return {
        messageId: msg.id, source: msg, senderName: latest.current.senderNameOf(msg.sender_user_id),
        // Only an explicit text selection is an excerpt. Attachment/card labels are presentation, not excerpts.
        originalContent: textSelection?.originalContent, selectionId: textSelection?.selectionId,
        content: msg.content_type === 'attachment' ? latest.current.attachmentLabel
          : msg.content_type === 'card' ? composerCardLine(msg.content ?? '') : msg.content ?? '',
      }
    })
  }, [setQuote])
  return { quote: stored?.chatId === chatId ? stored.quote : null, setQuote, onQuote }
}
