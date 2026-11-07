import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTokenCachePager } from './token-scan-worker/sqlite-cache';
import { tokenCachePartRange } from './token-file-cache';
let dir: string, path: string, db: Database.Database;
const pagers: ReturnType<typeof openTokenCachePager>[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-worker-sqlite-')); path = join(dir, 'synthetic.db'); db = new Database(path);
  db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE usage_token_file_cache (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT NOT NULL, data TEXT NOT NULL)');
});
afterEach(() => { for (const pager of pagers.splice(0)) pager.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
const row = (path: string) => ({ path, size: 10, mtimeMs: 20, provider: 'claude', providerSessionId: 'synthetic', data: '{}' });
const open = () => { const pager = openTokenCachePager(path, Database); pagers.push(pager); return pager; };
it('persists six columns and reads committed pages through a second connection', () => {
  const pager = open(); pager.checkpoint!(() => { pager.save(row('b')); pager.save(row('a')); });
  expect(pager.loadPage('', 1)).toEqual([{ path: 'a', size: 10, mtimeMs: 20, data: '{}' }]);
  expect(pager.loadPage('a', 40)).toHaveLength(1);
  expect(db.prepare('SELECT count(*) AS n FROM usage_token_file_cache').get()).toEqual({ n: 2 });
});
it('rolls back a failing SQL batch without publishing a head', () => {
  const pager = open();
  expect(() => pager.checkpoint!(() => { pager.save(row('part')); pager.save({ ...row('head'), provider: null as unknown as string }); })).toThrow();
  expect(pager.loadPage('', 40)).toEqual([]);
  pager.checkpoint!(() => pager.save(row('recovered'))); expect(pager.loadPage('', 40)).toHaveLength(1);
});
it('prunes bounded binary-prefix batches without deleting another file or the retained generation', () => {
  const pager = open(), file = '/synthetic/%_file';
  const stale = tokenCachePartRange(file, 'old'), keep = tokenCachePartRange(file, 'keep');
  pager.checkpoint!(() => { for (let i = 0; i < 85; i++) pager.save(row(stale.start + i)); pager.save(row(keep.start + '0')); pager.save(row('/other')); });
  pager.prune!(file, 'keep'); expect(pager.loadPage('', 100).map(value => value.path)).toEqual(['/other', keep.start + '0']);
});
it('does not hold a write transaction while serializing and publishes at most forty rows per SQL batch', () => {
  let inTransaction = false, rows = 0; const batches: number[] = [];
  const Traced = class extends Database {
    constructor(name: string, options: Database.Options = {}) { super(name, { ...options, verbose(sql: unknown) {
      if (typeof sql !== 'string') return;
      if (sql.startsWith('BEGIN')) { inTransaction = true; rows = 0; }
      if (sql.startsWith('INSERT')) rows++;
      if (sql.startsWith('COMMIT')) { batches.push(rows); inTransaction = false; }
    } }); }
  };
  const pager = openTokenCachePager(path, Traced); pagers.push(pager);
  pager.checkpoint!(() => { for (let i = 0; i < 96; i++) { expect(inTransaction).toBe(false); pager.save(row(String(i))); expect(inTransaction).toBe(false); } });
  expect(batches).toEqual([40, 40, 16]);
});
