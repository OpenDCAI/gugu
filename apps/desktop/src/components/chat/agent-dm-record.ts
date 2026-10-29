import type { MessageItem } from '@gugu/core/shared/types/chat'
import { readDeliveryEnvelope, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { replyItems, successfulMessageSend } from '@gugu/session-core/session-record/reply-process'
import { sentAttachmentOf, type AttachmentTurn, type SentAttachment } from '@gugu/session-core/session-record/sent-attachment'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { withSentReplies, type ChatMessage } from '@gugu/session-chat-ui'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { composerCardLine } from '@/lib/composerCardCopy'
import { visibleReplyQuoteIds } from './replyQuoteVisibility'
import { isPendingDelivery } from '@gugu/core/shared/ui/systemNotice'
import { partialQuotedContent } from './messageQuoteContent'

/** Pending delivery status ends only when that agent actually answers on the same line. */
export function displayedDmMessages(messages: readonly MessageItem[]): MessageItem[] {
  return messages.filter(message => !message.retracted_at && (!isPendingDelivery(message) || !messages.some(reply =>
    reply.seq > message.seq && reply.chat_id === message.chat_id && reply.thread_root_id === message.thread_root_id
    && reply.sender_user_id === message.sender_user_id && reply.content_type !== 'system' && !reply.retracted_at)))
}

/** Adapt authorized IM rows to the project transcript; never synthesize tool execution. */
export function dmRecord(messages: readonly MessageItem[], names: Readonly<Record<string, { display_name: string }>>): TranscriptTurn[] {
  const quotes = visibleReplyQuoteIds(messages)
  return displayedDmMessages(messages).map(message => {
    const partial = message.content_type === 'text' ? partialQuotedContent(message) : null
    const replyId = quotes.has(message.id) ? message.reply_to_message_id : null
    const reply = replyId ? {
      itemId: replyId, text: partial?.quoteText ?? message.reply_to_content ?? '',
      from: names[message.reply_to_sender_user_id ?? '']?.display_name,
      fromId: message.reply_to_sender_user_id ? `user:${message.reply_to_sender_user_id}` : undefined,
      ...(partial ? { excerpt: true } : {}),
    } : undefined
    const attachment = message.content_type === 'attachment' ? parseAttachmentContent(message.content, message) : null
    const link = attachment?.source.kind === 'url' ? attachment.source.url
      : attachment?.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}`
      : attachment?.source.kind === 'message' ? `gugu-message-file://${attachment.source.messageId}` : attachment ? `gugu-message-file://${message.id}` : null
    const content = attachment ? [attachment.caption, link ? `[${attachment.fileName}](${link})` : attachment.fileName].filter(Boolean).join('\n')
      : message.content_type === 'card' ? composerCardLine(message.content ?? '') : partial?.replyText ?? message.content ?? ''
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
      ...(attachment && link ? { sentAttachment: { messageId: message.id, name: attachment.fileName, href: link, ...(attachment.caption ? { caption: attachment.caption } : {}) } } : {}),
      ...(reply && (!message.is_mine || partial) ? { sentReplyTo: reply.itemId, conversationReply: reply } : {}),
    }
    // IM confirms a persisted message, not a duration or an execution process.
    return { id: `im:${message.id}`, seq: message.seq, initiator: message.is_mine ? 'user' : 'agent', items: [item] }
  })
}

/** Stable provenance, never body-text equality: a repeated “OK” is still another message. */
export function dmRecordIds(turns: readonly TranscriptTurn[]): Map<string, readonly string[]> {
  const ids = new Map<string, readonly string[]>()
  for (const turn of turns) for (const item of replyItems(turn)) {
    if (item.kind === 'message') {
      const messages = (readDeliveryEnvelope(item.text)?.segments ?? [])
        .flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId.replace(/^msg:/, '')] : [])
      if (messages.length) ids.set(item.id, messages)
      else if (turn.id === `im:${item.id}`) ids.set(item.id, [item.id])
      if (messages.length > 1) messages.forEach((id, index) => ids.set(`${item.id}:batch-${index}`, [id]))
      for (const id of messages) ids.set(id, [id])
    } else if (item.kind === 'session-notice' && turn.id === `im:${item.id}`) {
      ids.set(item.id, [item.id])
    } else if (item.kind === 'mcp-tool-call') {
      const sent = successfulMessageSend(item)?.id ?? sentAttachmentOf(item, (turn as AttachmentTurn).sentAttachments)?.messageId
      if (sent) ids.set(`${item.id}:sent:${sent}`, [sent])
    }
  }
  return ids
}

/** IM identity authorizes presentation only; preserve the provider's tools and wire envelopes. */
function projectDmExcerpts(turns: readonly TranscriptTurn[], messages: readonly MessageItem[], names: Readonly<Record<string, { display_name: string }>>): readonly TranscriptTurn[] {
  const excerpts = new Map(dmRecord(messages.filter(message => message.content_type === 'text' && partialQuotedContent(message)), names)
    .flatMap(turn => turn.items.flatMap(item => item.kind === 'message' ? [[item.id, item as ChatMessage] as const] : [])))
  if (!excerpts.size) return turns
  const aliases = dmRecordIds(turns)
  return turns.map(turn => {
    const projected = withSentReplies(turn, { allDestinations: true })
    return { ...projected, items: projected.items.map(item => {
      if (item.kind !== 'message') return item
      const envelope = readDeliveryEnvelope(item.text)
      if (envelope) {
        const replies: Record<string, NonNullable<ChatMessage['conversationReply']>> = {}
        const segments = envelope.segments.map(segment => {
          const facts = segment.facts, id = facts?.messageId?.replace(/^msg:/, '')
          const excerpt = id ? excerpts.get(id) : undefined
          if (!excerpt?.conversationReply || !facts || !id) return segment
          const own = readDeliveryEnvelope(excerpt.text)
          replies[id] = excerpt.conversationReply
          return { ...segment, body: own?.body ?? excerpt.text, facts: { ...facts,
            replyTo: facts.replyTo ? { ...facts.replyTo, preview: excerpt.conversationReply.text } : null } }
        })
        const values = Object.values(replies)
        return !values.length ? item : { ...item, guguDelivery: { segments, body: segments.map(segment => segment.body).join('\n\n') },
          ...(segments.length === 1 ? { conversationReply: values[0] } : { conversationReplies: replies }) }
      }
      const ids = aliases.get(item.id)
      const excerpt = ids?.length === 1 ? excerpts.get(ids[0]) : undefined
      return excerpt ? { ...item, text: excerpt.text, conversationReply: excerpt.conversationReply, sentReplyTo: excerpt.sentReplyTo } : item
    }) }
  })
}

export function mergeDmRecord(turns: readonly TranscriptTurn[], messages: readonly MessageItem[], names: Readonly<Record<string, { display_name: string }>>): readonly TranscriptTurn[] {
  const visible = displayedDmMessages(messages)
  const resolved = new Set(messages.filter(message => isPendingDelivery(message) && !visible.includes(message)).map(message => `im:${message.id}`))
  const base = resolved.size ? turns.filter(turn => !resolved.has(turn.id)) : turns
  const files: Record<string, SentAttachment> = {}
  for (const turn of dmRecord(messages.filter(message => message.content_type === 'attachment'), names)) {
    const file = (turn.items[0] as ChatMessage).sentAttachment
    if (file) files[file.messageId] = file
  }
  const enriched = Object.keys(files).length ? base.map(turn => {
    const known = Object.fromEntries(replyItems(turn).flatMap(item => {
      const file = sentAttachmentOf(item, files)
      return file ? [[file.messageId, file]] : []
    }))
    return Object.keys(known).length ? { ...turn, sentAttachments: known } : turn
  }) : base
  const projected = projectDmExcerpts(enriched, messages, names)
  const recorded = new Set([...dmRecordIds(projected).values()].flat())
  const known = messages.filter(message => recorded.has(message.id))
  const watermark = known.length ? Math.max(...known.map(message => message.seq)) : null
  const pending = dmRecord(visible.filter(message => !recorded.has(message.id) && (watermark === null || message.seq > watermark || message.local_send_state || isPendingDelivery(message))), names)
  // Session turns and IM messages have independent sequence spaces. Only the
  // adapter's turn order belongs to the transcript; keep the IM item seq intact.
  const lastSeq = projected.at(-1)?.seq ?? 0
  return pending.length ? [...projected, ...pending.map((turn, index) => ({ ...turn, seq: lastSeq + index + 1 }))] : projected
}
