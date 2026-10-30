import type { MessageItem } from '@gugu/core/shared/types/chat'

/** A persistent jump mark is only redundant when its explicit target is the row directly above. */
export function visibleReplyQuoteIds(messages: readonly MessageItem[]): ReadonlySet<string> {
  return new Set(messages.filter((message, index) => message.reply_to_message_id
    && message.reply_to_message_id !== messages[index - 1]?.id).map(message => message.id))
}
