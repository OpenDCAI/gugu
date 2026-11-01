import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { replyItems, successfulMessageSend } from '@gugu/session-core/session-record/reply-process'
import { sentAttachmentOf, type AttachmentTurn } from '@gugu/session-core/session-record/sent-attachment'

/** A visible later reply cannot read an earlier reply that has never entered the viewport. */
export class AgentDmReadCursor {
  private seen = new Set<string>()
  private skipped = new Set<string>()
  private pending = new Map<string, MessageItem>()
  private confirmedSeq: number
  constructor(readonly firstUnreadId: string | null, private readSeq: number, private readonly firstUnreadSeq?: number) { this.confirmedSeq = readSeq }
  acknowledge(seq: number): void {
    this.confirmedSeq = Math.max(this.confirmedSeq, seq)
    this.readSeq = Math.max(this.readSeq, seq)
    for (const [id, row] of this.pending) if (row.seq <= this.confirmedSeq) this.pending.delete(id)
  }
  ignore(ids: readonly string[]): void { for (const id of ids) { this.skipped.add(id); this.pending.delete(id) } }
  private firstWasRead(rows: readonly MessageItem[]): boolean {
    const seq = this.firstUnreadSeq ?? rows.find(row => row.id === this.firstUnreadId)?.seq
    return seq !== undefined && seq > 0 && seq <= this.confirmedSeq
  }

  visible(ids: readonly string[], rows: readonly MessageItem[]): MessageItem[] {
    for (const id of ids) this.seen.add(id)
    // IM can arrive before its transcript alias. A temporarily skipped row is
    // not acknowledged: reconsider it when the projection becomes visible.
    this.readSeq = this.confirmedSeq
    const unread = rows.filter(row => row.seq > this.confirmedSeq && !row.thread_root_id).sort((a, b) => a.seq - b.seq)
    // The first unread may still be outside the loaded IM window.
    if (this.firstUnreadId && !this.firstWasRead(rows) && !this.seen.has(this.firstUnreadId) && !this.skipped.has(this.firstUnreadId)) return []
    for (const row of unread) {
      if (!row.is_mine && !row.retracted_at && !this.seen.has(row.id) && !this.skipped.has(row.id)) break
      this.readSeq = row.seq
      if (this.seen.has(row.id)) this.pending.set(row.id, row)
    }
    // Reporting visibility is not an acknowledgement: an opening store may
    // not yet observe this chat. Retry until its read watermark confirms it.
    return [...this.pending.values()]
  }

  canFollow(rows: readonly MessageItem[]): boolean {
    return (!this.firstUnreadId || this.firstWasRead(rows) || this.seen.has(this.firstUnreadId) || this.skipped.has(this.firstUnreadId))
      && !rows.some(row => row.seq > this.readSeq && !row.is_mine && !row.retracted_at && !row.thread_root_id && !this.skipped.has(row.id))
  }
}

/** Native replay and session snapshots can use different turn prefixes; a send receipt stays canonical. */
export function visibleDmMessageIds(ids: readonly string[], dmIds: ReadonlyMap<string, readonly string[]>, rows: readonly MessageItem[]): string[] {
  const authorized = new Set(rows.map(row => row.id))
  return ids.flatMap(id => {
    const known = dmIds.get(id)
    if (known) return known.filter(messageId => authorized.has(messageId))
    const receipt = /:sent:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(id)?.[1]
    return authorized.has(id) ? [id] : receipt && authorized.has(receipt) ? [receipt] : []
  })
}

/**
 * The DM message ids each task-page item shows, read off the record itself: a delivery carries its message id in its
 * envelope (one per row of a batched delivery), an agent's deliberate message is its message_send receipt.
 */
export function dmMessageIdsByItem(turns: readonly TranscriptTurn[]): Map<string, readonly string[]> {
  const ids = new Map<string, readonly string[]>()
  for (const turn of turns) for (const item of replyItems(turn)) {
    if (item.kind === 'message') {
      const messages = (readDeliveryEnvelope(item.text)?.segments ?? [])
        .flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId.replace(/^msg:/, '')] : [])
      if (messages.length) ids.set(item.id, messages)
      if (messages.length > 1) messages.forEach((id, index) => ids.set(`${item.id}:batch-${index}`, [id]))
    } else if (item.kind === 'mcp-tool-call') {
      const sent = successfulMessageSend(item)?.id ?? sentAttachmentOf(item, (turn as AttachmentTurn).sentAttachments)?.messageId
      if (sent) ids.set(`${item.id}:sent:${sent}`, [sent])
    }
  }
  return ids
}
