/** A conversation, optionally one message in it. The reader still checks access when opening it. */
export type ConversationLink = { chatId: string; messageId?: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LINK = new RegExp(`^gugu-chat://(${UUID})(?:/(${UUID}))?/?$`, 'i')

/** A stable Markdown destination, shared by agent tools, chat and session transcripts. */
export function conversationLink(chatId: string, messageId?: string): string {
  const href = `gugu-chat://${chatId}${messageId ? `/${messageId}` : ''}`
  if (!parseConversationLink(href)) throw new Error('A conversation link requires a chat UUID and, optionally, a message UUID')
  return href
}

export function parseConversationLink(href: string): ConversationLink | null {
  const match = LINK.exec(href.trim())
  return match ? { chatId: match[1]!.toLowerCase(), ...(match[2] ? { messageId: match[2].toLowerCase() } : {}) } : null
}
