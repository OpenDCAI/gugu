import { expect, it, vi } from 'vitest'
import { contentWithQuote, parseQuotedContent, partialQuotedContent } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'

// Opt-in contract for the follow-up rollout; production defaults are covered separately.
vi.mock('../../../../apps/desktop/src/lib/messageQuoteRollout', () => ({ SELECTED_MESSAGE_QUOTES_ENABLED: true }))
it('separates a selected excerpt from reply text that itself starts with a Markdown quote', () => {
  const body = '> This is my reply.\n\nThen an explanation.'
  const wire = contentWithQuote(body, { messageId: 'source', senderName: 'Ada', content: 'Beta', originalContent: 'Alpha Beta' })
  expect(parseQuotedContent(wire)).toEqual({ senderName: 'Ada', quoteText: 'Beta', replyText: body })
})

it('preserves multiline excerpts including empty paragraphs before a quoted reply', () => {
  const wire = contentWithQuote('> Answer', { messageId: 'source', senderName: 'Ada', content: 'Beta\n\nFirst item', originalContent: 'Alpha Beta\n\nFirst item' })
  expect(parseQuotedContent(wire)).toEqual({ senderName: 'Ada', quoteText: 'Beta\n\nFirst item', replyText: '> Answer' })
})

it('does not strip an ambiguous old inline quote down to an empty message bubble', () => {
  expect(partialQuotedContent({ content: '> [Ada]: Beta\n> Answer', reply_to_message_id: 'source', reply_to_content: 'Alpha Beta' })).toBeNull()
})

it('leaves ordinary Markdown blockquotes outside the application quote format', () => {
  expect(parseQuotedContent('> A passage\n\nMy answer')).toBeNull()
})
