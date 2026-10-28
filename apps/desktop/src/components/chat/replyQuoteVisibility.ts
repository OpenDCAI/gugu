import { partialQuotedContent } from './messageQuoteContent'
import type { MessageItem } from '@gugu/core/shared/types/chat'

/** Presentation only. Partial search results and multi-party timelines cannot
 * establish direct-conversation adjacency, so retain their existing quotes. */
export function visibleReplyQuoteIds(messages: readonly MessageItem[], preserveAll = false): ReadonlySet<string> {
  const visible = new Set<string>()
  const seen = new Map<string, MessageItem>()
  const latestBySender = new Map<string, string>()
  let previous: MessageItem | undefined
  for (const message of messages) {
    if (preserveAll) { if (message.reply_to_message_id) visible.add(message.id); continue }
    if (message.content_type === 'system' || message.retracted_at) continue
    const target = message.reply_to_message_id ? seen.get(message.reply_to_message_id) : undefined
    const latestFromOther = !!message.sender_user_id && !!target?.sender_user_id && target.sender_user_id !== message.sender_user_id
      && latestBySender.get(target.sender_user_id) === target.id
    const repeated = !!message.sender_user_id && previous?.sender_user_id === message.sender_user_id
      && previous?.reply_to_message_id === message.reply_to_message_id
    if (message.reply_to_message_id && (partialQuotedContent(message) || (!latestFromOther && !repeated))) visible.add(message.id)
    seen.set(message.id, message)
    if (message.sender_user_id) latestBySender.set(message.sender_user_id, message.id)
    previous = message
  }
  return visible
}
