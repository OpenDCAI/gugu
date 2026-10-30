import type Database from 'better-sqlite3';
import { searchDocumentFromRow } from '@gugu/core/shared/search/document';
import { segment } from '@gugu/core/shared/search/segment';
import { searchTimestampMicros as micros } from '@gugu/core/shared/search/time';
import type { SearchIndexOp } from '@gugu/core/shared/search/types';

const stream = (threadRootId: string | null) => threadRootId ?? '';

/** Every op is idempotent, so a replayed revision or a re-read page leaves the same index. */
export function applyOps(db: Database.Database, accountId: string, ops: readonly SearchIndexOp[]): void {
  const putRow = db.prepare(`INSERT INTO msg
    (id,chat_id,thread_root_id,seq,sender_id,created_at,created_at_iso,text,body,is_whisper,to_user_ids,has_file,has_image,has_link)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    chat_id=excluded.chat_id,thread_root_id=excluded.thread_root_id,seq=excluded.seq,sender_id=excluded.sender_id,
    created_at=excluded.created_at,created_at_iso=excluded.created_at_iso,
    text=excluded.text,body=excluded.body,is_whisper=excluded.is_whisper,to_user_ids=excluded.to_user_ids,
    has_file=excluded.has_file,has_image=excluded.has_image,has_link=excluded.has_link`);
  const removeRow = db.prepare('DELETE FROM msg WHERE id=?');
  const known = db.prepare('SELECT 1 FROM chat WHERE id=?');
  for (const op of ops) {
    if (op.kind === 'rows') {
      for (const raw of op.rows) {
        const row = searchDocumentFromRow(raw, accountId);
        if (!row) {
          // A retracted (or otherwise no longer searchable) re-read replaces what was indexed.
          if (typeof raw.id === 'string') removeRow.run(raw.id);
          continue;
        }
        // Rows of a chat outside the current list are not kept: the list is the membership fact.
        if (!known.get(row.chatId)) continue;
        putRow.run(row.id, row.chatId, row.threadRootId, row.seq, row.senderId, micros(row.createdAt), row.createdAt,
          row.text, segment(row.text), Number(row.isWhisper), JSON.stringify(row.toUserIds),
          Number(row.hasFile), Number(row.hasImage), Number(row.hasLink));
      }
    } else if (op.kind === 'remove') {
      for (const id of op.ids) removeRow.run(id);
    } else if (op.kind === 'chats') {
      const put = db.prepare(`INSERT INTO chat VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,source_chat_id=excluded.source_chat_id`);
      for (const chat of op.chats) put.run(chat.id, chat.kind, chat.sourceChatId);
      const listed = new Set(op.chats.map((chat) => chat.id));
      const drop = db.prepare('DELETE FROM chat WHERE id=?');
      for (const { id } of db.prepare('SELECT id FROM chat').all() as { id: string }[]) if (!listed.has(id)) drop.run(id);
    } else if (op.kind === 'clearChat') {
      db.prepare('DELETE FROM msg WHERE chat_id=?').run(op.chatId);
      db.prepare('DELETE FROM coverage WHERE chat_id=?').run(op.chatId);
    } else {
      const { chatId, threadRootId, oldestSeq, newestSeq, exhausted } = op.coverage;
      if (!known.get(chatId)) continue;
      db.prepare(`INSERT INTO coverage VALUES (?,?,?,?,?) ON CONFLICT(chat_id,stream) DO UPDATE SET
        oldest_seq=excluded.oldest_seq,newest_seq=excluded.newest_seq,exhausted=excluded.exhausted`)
        .run(chatId, stream(threadRootId), oldestSeq, newestSeq, Number(exhausted));
    }
  }
}
