import { parseConversationLink, type ConversationLink } from '@gugu/core/shared/ui/conversationLink'

export const OPEN_CONVERSATION_LINK = '__open_conversation_link'
export type ConversationLinkRequest = { target: ConversationLink | null }

/** Claim this scheme before file/external handlers; malformed references are reported by the host too. */
export function openConversationLink(href: string): boolean {
  if (!/^gugu-chat:/i.test(href.trim())) return false
  const detail: ConversationLinkRequest = { target: parseConversationLink(href) }
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_LINK, { detail }))
  return true
}
