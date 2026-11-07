import type { MessageItem } from '@gugu/core/shared/types/chat'
import { projectMessageSearchText } from '@gugu/core/shared/ui/messageSearchText'
import type { ImMessageBatch, ImMessagePage, ImMessageRange, ImMessageWrite } from '@shared/core/im-messages'
import { createChatAccess } from './chat-access'
import { decimal, dropMessages, dropRanges, encodeRest, requireId, requireLimit, restore, reusingStatements,
  type MessageSqlDatabase, type StoredMessage } from './message-row'
import { searchMessages } from './search'

/** All durable messages and their derived index share the existing session connection. */
export function createImMessageStore(database: MessageSqlDatabase) {
  const connection = reusingStatements(database)
  const find = connection.prepare('SELECT rowid, claimed_revision FROM im_messages WHERE account_id = ? AND id = ?')
  const indexDelete = connection.prepare('DELETE FROM im_messages_text WHERE rowid = ?')
  const indexInsert = connection.prepare('INSERT INTO im_messages_text(rowid, text) VALUES (?, ?)')
  const isDeleted = connection.prepare(`SELECT 1 FROM im_message_tombstones
    WHERE account_id = ? AND chat_id = ? AND message_id IN ('', ?) LIMIT 1`)
  const upsert = connection.prepare(`INSERT INTO im_messages
    (account_id, id, chat_id, thread_root_id, seq, sender_user_id, created_at, content_type, content,
     is_whisper, to_user_ids, file_item_id, rest, claimed_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, id) DO UPDATE SET chat_id=excluded.chat_id,
      thread_root_id=excluded.thread_root_id, seq=excluded.seq, sender_user_id=excluded.sender_user_id,
      created_at=excluded.created_at, content_type=excluded.content_type, content=excluded.content,
      is_whisper=excluded.is_whisper, to_user_ids=excluded.to_user_ids,
      file_item_id=excluded.file_item_id, rest=excluded.rest,
      claimed_revision=COALESCE(im_messages.claimed_revision, excluded.claimed_revision)
    RETURNING rowid`)
  const progress = connection.prepare('SELECT through_revision FROM im_message_accounts WHERE account_id = ?')
  const writeProgress = connection.prepare(`INSERT INTO im_message_accounts(account_id, through_revision)
    VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET through_revision=excluded.through_revision`)
  const applyAccess = createChatAccess(connection)

  const revision = (accountId: string): string | null =>
    (progress.get(accountId) as { through_revision: string } | undefined)?.through_revision ?? null

  function cover(accountId: string, range: ImMessageRange): void {
    requireId(range.chatId)
    if (!Number.isSafeInteger(range.fromSeq) || !Number.isSafeInteger(range.toSeq)
      || range.fromSeq < 1 || range.toSeq < range.fromSeq) throw new Error('Invalid message coverage range')
    if (isDeleted.get(accountId, range.chatId, '')) return
    const root = range.threadRootId ?? ''
    const overlaps = connection.prepare(`SELECT from_seq,to_seq FROM im_message_ranges
      WHERE account_id=? AND chat_id=? AND thread_root_id=? AND from_seq<=? AND to_seq>=?`)
      .all(accountId, range.chatId, root, range.toSeq + 1, range.fromSeq - 1) as { from_seq: number; to_seq: number }[]
    const from = Math.min(range.fromSeq, ...overlaps.map(row => row.from_seq))
    const to = Math.max(range.toSeq, ...overlaps.map(row => row.to_seq))
    connection.prepare(`DELETE FROM im_message_ranges WHERE account_id=? AND chat_id=?
      AND thread_root_id=? AND from_seq<=? AND to_seq>=?`).run(accountId, range.chatId, root, to + 1, from - 1)
    connection.prepare('INSERT INTO im_message_ranges VALUES(?,?,?,?,?)').run(accountId, range.chatId, root, from, to)
  }

  /** A revision-ordered arrival continues the covered tail of its stream. */
  function extend(accountId: string, message: MessageItem): void {
    const row = connection.prepare(`SELECT max(to_seq) AS tail FROM im_message_ranges
      WHERE account_id=? AND chat_id=? AND thread_root_id=?`)
      .get(accountId, message.chat_id, message.thread_root_id ?? '') as { tail: number | null }
    cover(accountId, { chatId: message.chat_id, threadRootId: message.thread_root_id,
      fromSeq: row.tail !== null && row.tail < message.seq ? row.tail + 1 : message.seq, toSeq: message.seq })
  }

  function put(accountId: string, message: MessageItem, revision?: string): ImMessageWrite[] {
    requireId(message.id)
    requireId(message.chat_id)
    if (!Number.isSafeInteger(message.seq)) throw new Error('Invalid message sequence')
    if (message.seq < 1 || isDeleted.get(accountId, message.chat_id, message.id)) return []
    // Compute before mutating; either the original row and index both change, or neither does.
    const text = projectMessageSearchText(message)
    const rest = encodeRest(message)
    const old = find.get(accountId, message.id) as { rowid: number; claimed_revision: string | null } | undefined
    // @@@arrival-claim - the first revision that delivers a message claims it, even if a page fetch stored the body first;
    // the claim lives and dies with the row.
    const claims = revision !== undefined && !old?.claimed_revision
    if (old) indexDelete.run(old.rowid)
    const row = upsert.get(accountId, message.id, message.chat_id, message.thread_root_id ?? null,
      message.seq, message.sender_user_id, message.created_at, message.content_type, message.content,
      Number(message.is_whisper === true), JSON.stringify(message.to_user_ids), message.file_item_id ?? null,
      rest, claims ? revision : null) as { rowid: number }
    if (text) indexInsert.run(row.rowid, text)
    if (revision !== undefined) extend(accountId, message)
    const stored = connection.prepare('SELECT * FROM im_messages WHERE rowid=?').get(row.rowid) as StoredMessage
    return [{ type: 'put', message: restore(stored), ...(claims ? { claimed: true as const } : {}) }]
  }

  function write(accountId: string, operation: ImMessageWrite, revision?: string): ImMessageWrite[] {
    if (operation.type === 'put') return put(accountId, operation.message, revision)
    if (operation.type === 'chatAccess') return applyAccess(accountId, operation.access, revision)
    requireId(operation.chatId)
    if (operation.type === 'truncateRange') {
      dropRanges(connection, accountId, operation.chatId)
      return []
    }
    if (operation.type === 'delete') {
      requireId(operation.id)
      connection.prepare(`INSERT INTO im_message_tombstones(account_id, chat_id, message_id)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(accountId, operation.chatId, operation.id)
      dropMessages(connection, 'account_id = ? AND chat_id = ? AND id = ?', accountId, operation.chatId, operation.id)
      return [operation]
    }
    return applyAccess(accountId, { chatId: operation.chatId, ownMember: false, membershipRevoked: true }, revision)
  }

  const ingest = connection.transaction((accountId: string, batch: ImMessageBatch) => {
    requireId(accountId)
    const previous = revision(accountId)
    const applied: ImMessageWrite[] = []
    for (const operation of batch.writes) applied.push(...write(accountId, operation))
    for (const page of batch.revisions) {
      if (!decimal.test(page.revision)) throw new Error('Invalid message revision')
      // Another window or a crash before IndexedDB commit can replay a page already committed here.
      if (previous !== null && BigInt(page.revision) <= BigInt(previous)) continue
      for (const operation of page.writes) applied.push(...write(accountId, operation, page.revision))
    }
    for (const range of batch.ranges ?? []) cover(accountId, range)
    if (batch.throughRevision !== undefined) {
      if (!decimal.test(batch.throughRevision)) throw new Error('Invalid message through_revision')
      if (batch.revisions.some(page => BigInt(page.revision) > BigInt(batch.throughRevision!))) {
        throw new Error('Message revision exceeds the committed cursor')
      }
      if (previous === null || BigInt(batch.throughRevision) > BigInt(previous)) {
        writeProgress.run(accountId, batch.throughRevision)
      }
    }
    return applied
  })

  return {
    ingest,
    search: (accountId: string, chatId: string, query: string, limit: number, fromUserId?: string) =>
      searchMessages(connection, accountId, chatId, query, limit, fromUserId),
    throughRevision(accountId: string) { requireId(accountId); return revision(accountId) },
    windows(accountId: string, chatIds: string[], limit: number): MessageItem[] {
      requireId(accountId)
      requireLimit(limit)
      chatIds.forEach(requireId)
      // Each correlated range reads only a window from the stream index; no historical row_number scan.
      return (connection.prepare(`SELECT m.* FROM json_each(?) chats
        JOIN im_messages m ON m.rowid IN (SELECT rowid FROM im_messages
          WHERE account_id = ? AND chat_id = chats.value AND thread_root_id IS NULL
          ORDER BY seq DESC LIMIT ?) ORDER BY m.chat_id, m.seq`)
        .all(JSON.stringify(chatIds), accountId, limit) as StoredMessage[]).map(restore)
    },
    page(accountId: string, options: ImMessagePage) {
      requireId(accountId)
      requireLimit(options.limit)
      if (options.ids) {
        if (!options.ids.length || options.ids.length > 500) throw new Error('Invalid local message id page')
        options.ids.forEach(requireId)
        const rows = connection.prepare(`SELECT * FROM im_messages WHERE account_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY seq`)
          .all(accountId, JSON.stringify(options.ids)) as StoredMessage[]
        return { rows: rows.map(restore), covered: false }
      }
      requireId(options.chatId!)
      const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
      const after = options.afterSeq ?? 0
      if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(after) || after < 0) {
        throw new Error('Invalid persistent message cursor')
      }
      const args: unknown[] = [accountId, options.chatId]
      const stream = options.threadRootId ? '(thread_root_id=? OR id=?)' : 'thread_root_id IS NULL'
      if (options.threadRootId) args.push(options.threadRootId, options.threadRootId)
      const newer = options.afterSeq !== undefined
      const records = connection.prepare(`SELECT * FROM im_messages WHERE account_id=? AND chat_id=?
        AND ${stream} AND seq<? AND seq>? ORDER BY seq ${newer ? 'ASC' : 'DESC'} LIMIT ?`)
        .all(...args, before, after, options.limit) as StoredMessage[]
      const rows = records.map(restore)
      if (!newer) rows.reverse()
      const bottom = rows[0]?.seq ?? 1
      const top = rows[rows.length - 1]?.seq ?? after
      const range = connection.prepare(`SELECT from_seq,to_seq FROM im_message_ranges
        WHERE account_id=? AND chat_id=? AND thread_root_id=? AND from_seq<=? AND to_seq>=? LIMIT 1`)
        .get(accountId, options.chatId, options.threadRootId ?? '', newer ? after + 1 : bottom,
          newer ? top : before - 1) as { from_seq: number; to_seq: number } | undefined
      return { rows, covered: !!range && (rows.length === options.limit || (!newer && range.from_seq === 1)) }
    },
    clearAccount: connection.transaction((accountId: string) => {
      requireId(accountId)
      dropMessages(connection, 'account_id = ?', accountId)
      for (const table of ['im_message_tombstones', 'im_message_accounts', 'im_message_chats', 'im_message_ranges']) {
        connection.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId)
      }
    }),
  }
}
