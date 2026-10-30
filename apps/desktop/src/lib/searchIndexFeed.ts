// Global search (globalSearch.v3): the ONLY writer of the account's local message index.
// The index holds exactly what this account's own message reads returned — the server already applied
// visibility (membership, history floor, topics, whispers, deletion) — so this module only forwards facts
// and never decides who may see a row. With globalSearch.v3 off (or no desktop search host) nothing is sent; the main
// process still decides whether search.write writes (off: it opens nothing and drops the ops).
import type { RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { SearchChat, SearchCoverage, SearchIndexOp } from '@gugu/core/shared/search/types'
import { globalSearchV3Enabled } from '../session/renderer/features/global-search/global-search-flag'
import { rpcOn } from '../session/renderer/lib/ipc'
import { rendererLogger } from './log'

const log = rendererLogger('search-index')

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
    return rpcOn(null).search.write(ops)
  }).then(() => undefined)
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
  write.catch((error: unknown) => log.error({ error: String(error) }, 'apply failed'))
}

type ReadMessages = (...args: never[]) => Promise<readonly RawMessageRow[]>
type IndexedChatReads = {
  getMessages: ReadMessages
  getThreadMessages: ReadMessages
  deleteMessage: (messageId: string) => Promise<unknown>
  clearMessagesForMe: (chatId: string) => Promise<void>
}

/**
 * The chat service's own reads and removals are what the index is fed from: every page it reads (the window and the
 * backfill alike) and every message this device deletes or clears. Results and errors pass through unchanged; indexing
 * happens only after a call has succeeded and never fails it.
 */
export function withSearchIndexing<T extends IndexedChatReads>(service: T): T {
  const { getMessages, getThreadMessages, deleteMessage, clearMessagesForMe } = service
  const read = <F extends ReadMessages>(original: F) => (async (...args: Parameters<F>) => {
    const rows = await original.call(service, ...args)
    feedQuietly(feedRows(rows))
    return rows
  }) as F
  return Object.assign(service, {
    getMessages: read(getMessages),
    getThreadMessages: read(getThreadMessages),
    deleteMessage: async (messageId: string) => {
      const deleted = await deleteMessage.call(service, messageId)
      // Deleted for everyone or only for me: either way this account can no longer read it.
      feedQuietly(feedRemoved([messageId]))
      return deleted
    },
    clearMessagesForMe: async (chatId: string) => {
      await clearMessagesForMe.call(service, chatId)
      feedQuietly(feedClearChat(chatId))
    },
  })
}
