import type { MessageItem } from '@gugu/core/shared/types/chat'

/** Chat messages retain every explicit reply target; author and adjacency do not decide disclosure. */
export function visibleReplyQuoteIds(messages: readonly MessageItem[]): ReadonlySet<string> {
  return new Set(messages.filter(message => message.reply_to_message_id).map(message => message.id))
}
