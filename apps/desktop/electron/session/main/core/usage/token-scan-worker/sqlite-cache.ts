import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type { TokenCachePager } from '../token-scan-client';
import type { CachedLogFileRow, CachedLogFileSave } from '../token-scan';
import { tokenCachePartRange } from '../token-file-cache';

/** Worker-only connection. Packing runs outside bounded SQLite write transactions. */
export function openTokenCachePager(path: string, Constructor?: new (path: string, options?: Database.Options) => Database.Database): TokenCachePager & { close(): void } {
  const Sqlite = Constructor ?? createRequire(import.meta.url)('better-sqlite3') as typeof Database;
  const db = new Sqlite(path, { fileMustExist: true, timeout: 100 });
  db.pragma('busy_timeout = 100');
  const page = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, data FROM usage_token_file_cache WHERE path > ? ORDER BY path LIMIT ?');
  const save = db.prepare(`INSERT INTO usage_token_file_cache (path,size,mtime_ms,provider,provider_session_id,data)
    VALUES (@path,@size,@mtimeMs,@provider,@providerSessionId,@data) ON CONFLICT(path) DO UPDATE SET
    size=excluded.size,mtime_ms=excluded.mtime_ms,provider=excluded.provider,provider_session_id=excluded.provider_session_id,data=excluded.data`);
  const stale = db.prepare('SELECT path FROM usage_token_file_cache WHERE path >= ? AND path < ? AND (path < ? OR path >= ?) LIMIT 40');
  const remove = db.prepare('DELETE FROM usage_token_file_cache WHERE path = ?');
  let pending: CachedLogFileSave[] = [];
  let characters = 0;
  let checkpoint = false;
  const flush = () => {
    if (!pending.length) return;
    const rows = pending;
    pending = [];
    characters = 0;
    db.transaction(() => { for (const row of rows) save.run(row); })();
  };
  return {
    loadPage(after, limit) { return page.all(after, limit) as CachedLogFileRow[]; },
    save(row) {
      if (pending.length && (pending.length >= 40 || characters + row.data.length > 1 << 20)) flush();
      pending.push(row);
      characters += row.data.length;
      if (!checkpoint || pending.length >= 40 || characters >= 1 << 20) flush();
    },
    checkpoint(persist) {
      if (checkpoint) throw new Error('Nested token cache checkpoint');
      checkpoint = true;
      try { persist(); flush(); }
      finally { checkpoint = false; pending = []; characters = 0; }
    },
    prune(path, generation) {
      flush();
      const all = tokenCachePartRange(path);
      const keep = tokenCachePartRange(path, generation);
      for (;;) {
        const rows = stale.all(all.start, all.end, keep.start, keep.end) as { path: string }[];
        if (!rows.length) break;
        db.transaction(() => { for (const row of rows) remove.run(row.path); })();
      }
    },
    close() { pending = []; db.close(); },
  };
}
