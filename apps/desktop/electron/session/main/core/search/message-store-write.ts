import type Database from 'better-sqlite3';
import { searchDocumentFromRow } from '@gugu/core/shared/search/document';
import { segment } from '@gugu/core/shared/search/segment';
import { searchTimestampMicros as micros } from '@gugu/core/shared/search/time';
import type { SearchIndexOp } from '@gugu/core/shared/search/types';

const stream = (threadRootId: string | null) => threadRootId ?? '';

/** Every op is idempotent, so a replayed revision or a re-read page leaves the same index. */
export function applyOps(db: Database.Database, accountId: string, ops: readonly SearchIndexOp[]): void {
  const putRow = db.prepare(`INSERT INTO msg
    (id,chat_id,task_id,message_ref,role,thread_root_id,seq,sender_id,created_at,created_at_iso,text,is_whisper,to_user_ids,has_file,has_image,has_link)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    chat_id=excluded.chat_id,task_id=excluded.task_id,message_ref=excluded.message_ref,role=excluded.role,
    thread_root_id=excluded.thread_root_id,seq=excluded.seq,sender_id=excluded.sender_id,
    created_at=excluded.created_at,created_at_iso=excluded.created_at_iso,
    text=excluded.text,is_whisper=excluded.is_whisper,to_user_ids=excluded.to_user_ids,
    has_file=excluded.has_file,has_image=excluded.has_image,has_link=excluded.has_link RETURNING rowid`);
  const putFts = db.prepare('INSERT OR REPLACE INTO msg_fts(rowid,body) VALUES (?,?)');
  const put = (text: string, values: unknown[]) => {
    const { rowid } = putRow.get(...values) as { rowid: number };
    putFts.run(rowid, segment(text));
  };
  const removeRow = db.prepare('DELETE FROM msg WHERE id=?');
  const known = db.prepare('SELECT 1 FROM chat WHERE id=?');
  const knownTask = db.prepare('SELECT 1 FROM task WHERE id=?');
  const putTask = db.prepare(`INSERT INTO task VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,project_id=excluded.project_id,agent_user_id=excluded.agent_user_id,terminal=excluded.terminal,archived=excluded.archived`);
  for (const op of ops) {
    if (op.kind === 'rows') {
      for (const raw of op.rows) {
        const row = searchDocumentFromRow(raw, accountId);
        if (!row) {
          if (typeof raw.id === 'string') removeRow.run(raw.id);
          continue;
        }
        if (!known.get(row.chatId)) continue;
        put(row.text, [row.id, row.chatId, null, null, null, row.threadRootId, row.seq, row.senderId, micros(row.createdAt), row.createdAt,
          row.text, Number(row.isWhisper), JSON.stringify(row.toUserIds), Number(row.hasFile), Number(row.hasImage), Number(row.hasLink)]);
      }
    } else if (op.kind === 'remove') {
      for (const id of op.ids) removeRow.run(id);
    } else if (op.kind === 'chats') {
      const putChat = db.prepare(`INSERT INTO chat VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,source_chat_id=excluded.source_chat_id`);
      for (const chat of op.chats) putChat.run(chat.id, chat.kind, chat.sourceChatId);
      const listed = new Set(op.chats.map(chat => chat.id));
      const drop = db.prepare('DELETE FROM chat WHERE id=?');
      for (const { id } of db.prepare('SELECT id FROM chat').all() as { id: string }[]) if (!listed.has(id)) drop.run(id);
    } else if (op.kind === 'clearChat') {
      db.prepare('DELETE FROM msg WHERE chat_id=?').run(op.chatId);
      db.prepare('DELETE FROM coverage WHERE chat_id=?').run(op.chatId);
    } else if (op.kind === 'coverage') {
      const { chatId, threadRootId, oldestSeq, newestSeq, exhausted } = op.coverage;
      if (!known.get(chatId)) continue;
      db.prepare(`INSERT INTO coverage VALUES (?,?,?,?,?) ON CONFLICT(chat_id,stream) DO UPDATE SET
        oldest_seq=excluded.oldest_seq,newest_seq=excluded.newest_seq,exhausted=excluded.exhausted`)
        .run(chatId, stream(threadRootId), oldestSeq, newestSeq, Number(exhausted));
    } else if (op.kind === 'task' || op.kind === 'tasks') {
      const tasks = op.kind === 'task' ? [op.task] : op.tasks;
      for (const task of tasks) putTask.run(task.id, task.title, task.projectId, task.agentUserId ?? null, Number(task.terminal === true), Number(task.archived === true));
      if (op.kind === 'tasks') {
        const listed = new Set(tasks.map(task => task.id));
        for (const { id } of db.prepare('SELECT id FROM task').all() as { id: string }[]) {
          if (!listed.has(id)) db.prepare('DELETE FROM task WHERE id=?').run(id);
        }
      }
    } else if (op.kind === 'removeTask') {
      db.prepare('DELETE FROM task WHERE id=?').run(op.taskId);
    } else if (op.kind === 'taskTurn') {
      db.prepare('DELETE FROM msg WHERE task_id=? AND seq=?').run(op.taskId, op.seq);
      if (!knownTask.get(op.taskId)) continue;
      for (const row of op.documents) {
        if (row.taskId !== op.taskId || row.seq !== op.seq) throw new Error('Task document belongs to another turn');
        put(row.text, [row.id, null, row.taskId, row.reference, row.role, null, row.seq,
          row.senderId === undefined ? (row.role === 'user' ? accountId : null) : row.senderId,
          row.createdAt === null ? null : micros(row.createdAt), row.createdAt, row.text, 0, '[]', 0, 0, 0]);
      }
    } else if (op.kind === 'truncateTask') {
      db.prepare('DELETE FROM msg WHERE task_id=? AND seq>=?').run(op.taskId, op.fromSeq);
      db.prepare('DELETE FROM task_coverage WHERE task_id=?').run(op.taskId);
    } else if (op.kind === 'taskCoverage') {
      if (!knownTask.get(op.coverage.taskId)) continue;
      const { taskId, lastSeq, exhausted, reason } = op.coverage;
      db.prepare(`INSERT INTO task_coverage VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        last_seq=excluded.last_seq,exhausted=excluded.exhausted,reason=excluded.reason`)
        .run(taskId, lastSeq, Number(exhausted), reason ?? null);
    }
  }
}
