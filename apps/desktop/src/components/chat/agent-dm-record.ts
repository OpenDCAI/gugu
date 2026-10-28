import type { MessageItem } from '@gugu/core/shared/types/chat'
import { readDeliveryEnvelope, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { replyItems, sentMessageId } from '@gugu/session-core/session-record/reply-process'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { ChatMessage } from '@gugu/session-chat-ui'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { composerCardLine } from '@/lib/composerCardCopy'
import { visibleReplyQuoteIds } from './replyQuoteVisibility'

/** Adapt authorized IM rows to the project transcript; never synthesize tool execution. */
export function dmRecord(messages: readonly MessageItem[], names: Readonly<Record<string, { display_name: string }>>): TranscriptTurn[] {
  const quotes = visibleReplyQuoteIds(messages)
  return messages.filter(message => !message.retracted_at).map(message => {
    const replyId = quotes.has(message.id) ? message.reply_to_message_id : null
    const reply = replyId ? {
      itemId: replyId, text: message.reply_to_content ?? '',
      from: names[message.reply_to_sender_user_id ?? '']?.display_name,
      fromId: message.reply_to_sender_user_id ? `user:${message.reply_to_sender_user_id}` : undefined,
    } : undefined
    const attachment = message.content_type === 'attachment' ? parseAttachmentContent(message.content, message) : null
    const link = attachment?.source.kind === 'url' ? attachment.source.url
      : attachment?.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}`
      : attachment?.source.kind === 'message' ? `gugu-message-file://${attachment.source.messageId}` : null
    const content = attachment ? [attachment.caption, link ? `[${attachment.fileName}](${link})` : attachment.fileName].filter(Boolean).join('\n')
      : message.content_type === 'card' ? composerCardLine(message.content ?? '') : message.content ?? ''
    if (message.content_type === 'system') return { id: `im:${message.id}`, seq: message.seq, initiator: 'agent', items: [{
      kind: 'session-notice', id: message.id, seq: message.seq, code: 'provider-notice', detail: content, at: Date.parse(message.created_at),
    }] }

    const item: Omit<ChatMessage, 'attachments' | 'role' | 'seq'> & { role: 'user' | 'assistant'; seq: number } = {
      kind: 'message', id: message.id, seq: message.seq, role: message.is_mine ? 'user' : 'assistant',
      text: message.is_mine ? renderDeliveryEnvelope({ route: 'chat', from: names[message.sender_user_id ?? '']?.display_name ?? null,
        fromId: `user:${message.sender_user_id ?? ''}`, fromType: 'human', messageId: `msg:${message.id}`, at: message.created_at,
        chat: message.chat_id, chatKind: 'ai', content,
        ...(reply && reply.fromId ? { replyTo: { messageId: `msg:${reply.itemId}`, fromId: reply.fromId, from: reply.from ?? null, preview: reply.text } } : {}),
      }) : content,
      at: Date.parse(message.created_at),
      ...(reply && !message.is_mine ? { sentReplyTo: reply.itemId, conversationReply: reply } : {}),
    }
    // IM confirms a persisted message, not a duration or an execution process.
    return { id: `im:${message.id}`, seq: message.seq, initiator: message.is_mine ? 'user' : 'agent', items: [item] }
  })
}

/** Stable provenance, never body-text equality: a repeated “OK” is still another message. */
export function dmRecordIds(turns: readonly TranscriptTurn[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const turn of turns) for (const item of replyItems(turn)) {
    if (item.kind === 'message') {
      for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
        const id = segment.facts?.messageId?.replace(/^msg:/, '')
        if (id) ids.set(item.id, id)
      }
    } else if (item.kind === 'mcp-tool-call') {
      const sent = sentMessageId(item)
      if (sent) ids.set(`${item.id}:sent:${sent}`, sent)
    }
  }
  return ids
}

export function mergeDmRecord(turns: readonly TranscriptTurn[], messages: readonly MessageItem[], names: Readonly<Record<string, { display_name: string }>>): readonly TranscriptTurn[] {
  const recorded = new Set(dmRecordIds(turns).values())
  const known = messages.filter(message => recorded.has(message.id))
  const watermark = known.length ? Math.max(...known.map(message => message.seq)) : null
  const pending = dmRecord(messages.filter(message => !recorded.has(message.id) && (watermark === null || message.seq > watermark || message.local_send_state)), names)
  return pending.length ? [...turns, ...pending] : turns
}
