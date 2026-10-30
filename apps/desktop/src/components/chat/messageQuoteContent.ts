import type { MessageItem } from '@gugu/core/shared/types/chat'
import { SELECTED_MESSAGE_QUOTES_ENABLED } from '../../lib/messageQuoteRollout'

export interface QuoteSelection {
  originalContent: string | null
  selectionId?: string
  clear?: boolean
}

/** Existing composer wire format; ordinary Markdown blockquotes are left alone. */
export function parseQuotedContent(content: string): { senderName: string; quoteText: string; replyText: string } | null {
  if (!content.startsWith('> ')) return null
  const lines = content.split('\n')
  const quoteLines: string[] = []
  let i = 0
  while (i < lines.length && lines[i].startsWith('> ')) quoteLines.push(lines[i++].slice(2))
  while (i < lines.length && lines[i].trim() === '') i++
  const nameMatch = quoteLines.join('\n').match(/^\[([^\]]*)\]: (.*)$/s)
  return nameMatch ? { senderName: nameMatch[1]!, quoteText: nameMatch[2]!, replyText: lines.slice(i).join('\n').trim() } : null
}

/** Keep the structural source link, but display the explicitly chosen excerpt. */
export function partialQuotedContent(msg: Pick<MessageItem, 'content' | 'reply_to_message_id' | 'reply_to_content'>) {
  if (!msg.reply_to_message_id) return null
  const parsed = parseQuotedContent(msg.content ?? '')
  return parsed?.replyText && parsed.quoteText !== msg.reply_to_content ? parsed : null
}

export function contentWithQuote(typed: string, quote?: { messageId?: string; senderName: string; content: string; originalContent?: string | null } | null) {
  if (!typed || !quote) return typed
  const partial = quote.originalContent != null && quote.content !== quote.originalContent
  if (partial && !SELECTED_MESSAGE_QUOTES_ENABLED) return typed
  if (quote.messageId && !partial) return typed
  // A blank line ends the quoted block even when the reply itself begins with Markdown `> `.
  return `> [${quote.senderName}]: ${quote.content.split('\n').join('\n> ')}\n\n${typed}`
}
