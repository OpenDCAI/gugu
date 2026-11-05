import type { MessageItem } from '@gugu/core/shared/types/chat'
import { projectMessageSearchText } from '@gugu/core/shared/ui/messageSearchText'
import { requireId, requireLimit, restore, type MessageSqlDatabase, type StoredMessage } from './message-row'

const yieldToHost = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Newest-first scan of one conversation, 100 rows per step, yielding between steps; returns oldest-first. */
export async function searchMessages(connection: MessageSqlDatabase, accountId: string, chatId: string,
  query: string, limit: number, fromUserId?: string): Promise<MessageItem[]> {
  requireId(accountId)
  requireId(chatId)
  requireLimit(limit)
  if (fromUserId !== undefined) requireId(fromUserId)
  const words = query.trim().split(/\s+/).filter(Boolean)
  // Trigram FTS matches pieces of three or more characters; shorter pieces are checked on the projected text below.
  const long = words.filter(word => [...word].length >= 3).map(word => `"${word.replaceAll('"', '""')}"`)
  const short = words.filter(word => [...word].length < 3).map(word => word.toLowerCase())
  const next = connection.prepare(`SELECT m.* FROM im_messages m
    ${long.length ? 'JOIN im_messages_text ON im_messages_text.rowid=m.rowid' : ''}
    WHERE m.account_id=? AND m.chat_id=? ${fromUserId ? 'AND m.sender_user_id=?' : ''}
    ${long.length ? 'AND im_messages_text MATCH ?' : ''} AND (m.seq,m.rowid)<(?,?)
    ORDER BY m.seq DESC,m.rowid DESC LIMIT 100`)
  const found: MessageItem[] = []
  let cursor = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  for (;;) {
    const rows = next.all(accountId, chatId, ...(fromUserId ? [fromUserId] : []),
      ...(long.length ? [long.join(' AND ')] : []), ...cursor) as StoredMessage[]
    for (const row of rows) {
      const message = restore(row)
      // Only rows with searchable text are results (the index holds the same projection), with or without words.
      const text = projectMessageSearchText(message)?.toLowerCase() ?? ''
      if (text && short.every(word => text.includes(word))) found.push(message)
      if (found.length === limit) return found.reverse()
    }
    if (rows.length < 100) return found.reverse()
    const last = rows[rows.length - 1]!
    cursor = [last.seq, last.rowid]
    await yieldToHost()
  }
}
