// Global search (globalSearch.v3): the ONLY writer of the account's local message index.
// The index holds exactly what this account's own message reads returned — the server already applied
// visibility (membership, history floor, topics, whispers, deletion) — so this module only forwards facts
// and never decides who may see a row. Every call is a no-op while the flag is off.
import type { RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { SearchChat, SearchCoverage, SearchIndexOp } from '@gugu/core/shared/search/types'
import { globalSearchV3Enabled } from '../session/renderer/features/global-search/global-search-flag'
import { rpcOn } from '../session/renderer/lib/ipc'

let queued: SearchIndexOp[] = []
let flush: Promise<void> | null = null

/** Ops queued in one task are applied in one store transaction. */
function feed(op: SearchIndexOp): Promise<void> {
  if (!globalSearchV3Enabled()) return Promise.resolve()
  queued.push(op)
  flush ??= Promise.resolve().then(() => {
    const ops = queued
    queued = []
    flush = null
    // The index belongs to this computer's account session, never to a machine a row id happens to resemble.
    return rpcOn(null).search.apply(ops)
  })
  return flush
}

/** Rows exactly as a messages_view read (or the message_created revision) returned them. */
export const feedRows = (rows: readonly RawMessageRow[]) => rows.length ? feed({ kind: 'rows', rows: [...rows] }) : Promise.resolve()
export const feedRemoved = (ids: readonly string[]) => ids.length ? feed({ kind: 'remove', ids: [...ids] }) : Promise.resolve()
/** The authoritative chat list; a chat missing from it is purged. */
export const feedChats = (chats: readonly SearchChat[]) => feed({ kind: 'chats', chats: [...chats] })
export const feedClearChat = (chatId: string) => feed({ kind: 'clearChat', chatId })
export const feedCoverage = (coverage: SearchCoverage) => feed({ kind: 'coverage', coverage })

/** Read-path callers must not fail their own read because indexing failed; the backfill re-reads. */
export function feedQuietly(write: Promise<void>): void {
  write.catch((error) => console.error('[search-index] apply failed', error))
}
