import { describe, expect, it } from 'vitest'
import { conversationLink, parseConversationLink } from '../../../../packages/core/src/shared/ui/guguLink'

const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const message = '11111111-2222-4333-8444-555555555555'

describe('conversation links', () => {
  it('round-trips a conversation and an exact message without inferring an identity', () => {
    expect(parseConversationLink(conversationLink(chat))).toEqual({ chatId: chat })
    expect(parseConversationLink(conversationLink(chat, message))).toEqual({ chatId: chat, messageId: message })
  })

  it('rejects ambiguous destinations and executable URL syntax', () => {
    for (const href of [`https://example.com/${chat}`, `gugu-chat://${chat}/missing`, `gugu-chat://other@${chat}`, `gugu-chat://${chat}?other=1`, `gugu-chat://${chat}/../${message}`, `javascript:alert(1)`]) {
      expect(parseConversationLink(href)).toBeNull()
    }
    expect(() => conversationLink('not-a-chat')).toThrow()
  })
})
