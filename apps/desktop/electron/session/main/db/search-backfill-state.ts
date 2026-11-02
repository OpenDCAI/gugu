import type Database from 'better-sqlite3';
import type { SearchBackfillProgress, TaskTurnIndexStatus } from '@shared/core/search';

let current: SearchBackfillProgress | undefined;
export function setSearchBackfillProgress(progress: SearchBackfillProgress): void { current = progress; }
export function parseSearchBackfillProgress(value: unknown): SearchBackfillProgress | null {
  const p = value as SearchBackfillProgress | null;
  return p && ['running', 'complete', 'failed'].includes(p.state) && Number.isSafeInteger(p.done) && Number.isSafeInteger(p.total)
    && p.done >= 0 && p.total >= p.done ? { state: p.state, done: p.done, total: p.total } : null;
}
export function taskTurnIndexStatus(connection: Database.Database): TaskTurnIndexStatus {
  const values = connection.prepare("SELECT key,value FROM kv WHERE key IN ('fts_version','turn_text_backfilled')").all() as { key: string; value: string }[];
  const version = values.find(row => row.key === 'fts_version')?.value;
  const complete = values.find(row => row.key === 'turn_text_backfilled')?.value;
  if (version && version === complete) return { state: 'ready' };
  return { state: current?.state === 'failed' ? 'failed' : 'preparing', ...(current ? { done: current.done, total: current.total } : {}) };
}
