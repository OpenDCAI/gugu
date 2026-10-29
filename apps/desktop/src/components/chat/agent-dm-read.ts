import type { MessageItem } from '@gugu/core/shared/types/chat'

/** A visible later reply cannot read an earlier reply that has never entered the viewport. */
export class AgentDmReadCursor {
  private seen = new Set<string>()
  private skipped = new Set<string>()
  private committed = new Set<string>()
  constructor(readonly firstUnreadId: string | null, private readSeq: number) {}
  ignore(ids: readonly string[]): void { for (const id of ids) this.skipped.add(id) }

  visible(ids: readonly string[], rows: readonly MessageItem[]): MessageItem[] {
    for (const id of ids) this.seen.add(id)
    const unread = rows.filter(row => row.seq > this.readSeq && !row.thread_root_id).sort((a, b) => a.seq - b.seq)
    // The first unread may still be outside the loaded IM window.
    if (this.firstUnreadId && !this.seen.has(this.firstUnreadId) && !this.skipped.has(this.firstUnreadId)) return []
    const ready: MessageItem[] = []
    for (const row of unread) {
      if (!row.is_mine && !row.retracted_at && !this.seen.has(row.id) && !this.skipped.has(row.id)) break
      this.readSeq = row.seq
      if (this.seen.has(row.id) && !this.committed.has(row.id)) {
        ready.push(row)
        this.committed.add(row.id)
      }
    }
    return ready
  }

  canFollow(rows: readonly MessageItem[]): boolean {
    return (!this.firstUnreadId || this.seen.has(this.firstUnreadId) || this.skipped.has(this.firstUnreadId))
      && !rows.some(row => row.seq > this.readSeq && !row.is_mine && !row.retracted_at && !row.thread_root_id && !this.skipped.has(row.id))
  }
}

export function dmTranscriptItem(messageId: string, aliases: ReadonlyMap<string, readonly string[]>): string | null {
  // Prefer the projected item (tool:sent:id / provider delivery) over its canonical alias.
  for (const [itemId, ids] of aliases) if (itemId !== messageId && ids.includes(messageId)) return itemId
  return aliases.has(messageId) ? messageId : null
}

/** Native replay and session snapshots can use different turn prefixes; a send receipt stays canonical. */
export function visibleDmMessageIds(ids: readonly string[], aliases: ReadonlyMap<string, readonly string[]>, rows: readonly MessageItem[]): string[] {
  const authorized = new Set(rows.map(row => row.id))
  return ids.flatMap(id => {
    const known = aliases.get(id)
    if (known) return known.filter(messageId => authorized.has(messageId))
    const receipt = /:sent:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(id)?.[1]
    return authorized.has(id) ? [id] : receipt && authorized.has(receipt) ? [receipt] : []
  })
}
