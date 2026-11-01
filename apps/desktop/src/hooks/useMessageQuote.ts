import { useCallback, useLayoutEffect, useRef, type SetStateAction } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { composerCardLine } from '../lib/composerCardCopy'
import type { ChatMessageComposerProps } from '../components/chat/chatComposerModels'
import type { QuoteSelection } from '../components/chat/messageQuoteContent'
import { useChatStore } from '../store/chatContext'

type Quote = NonNullable<ChatMessageComposerProps['quoteContent']>

/** Every conversation surface preserves the same selection intent, source and cancellation token. */
export function useMessageQuote(chatId: string | null, senderNameOf: (id: string | null) => string, attachmentLabel: string,
  previewTextOf?: (message: MessageItem) => string) {
  const { draftQuotes, setDraftQuote } = useChatStore('draftQuotes', 'setDraftQuote')
  const quote = chatId ? draftQuotes[chatId] ?? null : null
  const previous = useRef({ chatId, quote })
  useLayoutEffect(() => {
    const old = previous.current
    previous.current = { chatId, quote }
    if (old.chatId && old.chatId !== chatId) setDraftQuote(old.chatId, current => current === old.quote ? null : current)
  }, [chatId, quote, setDraftQuote])
  const latest = useRef({ senderNameOf, attachmentLabel, previewTextOf })
  latest.current = { senderNameOf, attachmentLabel, previewTextOf }
  const setQuote = useCallback((next: SetStateAction<Quote | null | undefined>) => {
    if (chatId) setDraftQuote(chatId, next)
  }, [chatId, setDraftQuote])
  const onQuote = useCallback((msg: MessageItem, selection?: QuoteSelection) => {
    setQuote(current => {
      if (selection?.clear) return selection.selectionId && current?.selectionId === selection.selectionId ? null : current
      const textSelection = msg.content_type === 'text' ? selection : undefined
      return {
        messageId: msg.id, source: msg, senderName: latest.current.senderNameOf(msg.sender_user_id),
        // Only an explicit text selection is an excerpt. Attachment/card labels are presentation, not excerpts.
        originalContent: textSelection?.originalContent, selectionId: textSelection?.selectionId,
        content: !textSelection && latest.current.previewTextOf ? latest.current.previewTextOf(msg)
          : msg.content_type === 'attachment' ? latest.current.attachmentLabel
          : msg.content_type === 'card' ? composerCardLine(msg.content ?? '') : msg.content ?? '',
      }
    })
  }, [setQuote])
  return { quote, setQuote, onQuote }
}
