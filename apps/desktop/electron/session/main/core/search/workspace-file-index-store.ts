import { basename } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';

export type FileHit = { path: string; filename: string };
export type FileIndexStatus = 'complete' | 'stale' | 'truncated';
export type FileIndexTruncateReason = 'maxEntries' | 'timeBudget';
export type FileIndexMeta = {
  rootPath: string;
  status: FileIndexStatus;
  fileCount: number;
  truncateReason: FileIndexTruncateReason | null;
};

const SYNC_BATCH_SIZE = 500;
const SUBTREE_DELETE_BATCH_SIZE = 500;

export const WORKSPACE_FILE_INDEX_SQL = {
  insertIdentity: `
    INSERT OR IGNORE INTO workspace_file_index_rows(workspace_id, path, filename)
    VALUES (?, ?, ?)
  `,
  insertFts: `
    INSERT INTO workspace_file_index(rowid, workspace_id, path, filename)
    VALUES (?, ?, ?, ?)
  `,
  selectIdentity: `
    SELECT rowid, workspace_id, path, filename
    FROM workspace_file_index_rows
    WHERE workspace_id = ? AND path = ?
  `,
  deleteFts: `
    INSERT INTO workspace_file_index(workspace_file_index, rowid, workspace_id, path, filename)
    VALUES ('delete', ?, ?, ?, ?)
  `,
  deleteIdentity: `
    DELETE FROM workspace_file_index_rows WHERE workspace_id = ? AND path = ?
  `,
  hasIdentity: `
    SELECT 1 FROM workspace_file_index_rows WHERE workspace_id = ? AND path = ? LIMIT 1
  `,
} as const;

export interface IWorkspaceFileIndexStore {
  transaction<T>(fn: () => T): T;
  getMeta(workspaceId: string): FileIndexMeta | null;
  recordMeta(workspaceId: string, meta: FileIndexMeta): void;
  refreshMetaTimestamp(workspaceId: string): void;
  syncRows(workspaceId: string, paths: string[], shouldContinue?: () => boolean): Promise<boolean>;
  insertPath(workspaceId: string, path: string): boolean;
  deletePath(workspaceId: string, path: string): boolean;
  deleteSubtree(workspaceId: string, path: string): Promise<void>;
  countIndexedFiles(workspaceId: string): number;
  searchFiles(workspaceId: string, query: string, limit: number): FileHit[];
  search(workspaceId: string, query: string): FileHit[];
  deleteIndex(workspaceId: string): Promise<void>;
  evict(staleDays: number): Promise<void>;
}

export class WorkspaceFileIndexStore implements IWorkspaceFileIndexStore {
  private preparedStatements?: {
    insertIdentity: BetterSqlite3.Statement;
    insertFts: BetterSqlite3.Statement;
    selectIdentity: BetterSqlite3.Statement;
    deleteFts: BetterSqlite3.Statement;
    deleteIdentity: BetterSqlite3.Statement;
    hasIdentity: BetterSqlite3.Statement;
  };

  private get statements() {
    if (!this.preparedStatements) {
      this.preparedStatements = {
        insertIdentity: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.insertIdentity),
        insertFts: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.insertFts),
        selectIdentity: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.selectIdentity),
        deleteFts: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.deleteFts),
        deleteIdentity: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.deleteIdentity),
        hasIdentity: sqlite.prepare(WORKSPACE_FILE_INDEX_SQL.hasIdentity),
      };
    }
    return this.preparedStatements!;
  }

  transaction<T>(fn: () => T): T {
    return sqlite.transaction(fn)();
  }

  getMeta(workspaceId: string): FileIndexMeta | null {
    try {
      const row = sqlite
        .prepare(
          `SELECT root_path, status, file_count, truncate_reason
           FROM workspace_file_index_meta
           WHERE workspace_id = ?`
        )
        .get(workspaceId) as
        | { root_path: string; status: string; file_count: number; truncate_reason: string | null }
        | undefined;

      if (!row || !isFileIndexStatus(row.status)) return null;
      return {
        rootPath: row.root_path,
        status: row.status,
        fileCount: row.file_count,
        truncateReason: isFileIndexTruncateReason(row.truncate_reason) ? row.truncate_reason : null,
      };
    } catch (e) {
      log.warn('WorkspaceFileIndexStore: getMeta failed', { workspaceId, error: String(e) });
      return null;
    }
  }

  recordMeta(workspaceId: string, meta: FileIndexMeta): void {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO workspace_file_index_meta (
           workspace_id,
           indexed_at,
           root_path,
           status,
           file_count,
           truncate_reason
         )
         VALUES (?, unixepoch(), ?, ?, ?, ?)`
      )
      .run(workspaceId, meta.rootPath, meta.status, meta.fileCount, meta.truncateReason);
  }

  refreshMetaTimestamp(workspaceId: string): void {
    try {
      sqlite
        .prepare(
          `UPDATE workspace_file_index_meta
           SET indexed_at = unixepoch()
           WHERE workspace_id = ?`
        )
        .run(workspaceId);
    } catch (e) {
      log.warn('WorkspaceFileIndexStore: refreshMetaTimestamp failed', {
        workspaceId,
        error: String(e),
      });
    }
  }

  async syncRows(
    workspaceId: string,
    paths: string[],
    shouldContinue: () => boolean = () => true
  ): Promise<boolean> {
    const existingPaths = this.indexedPathSet(workspaceId);
    const desiredPaths = new Set<string>(paths);

    const deletions = [...existingPaths].filter((path) => !desiredPaths.has(path));
    const additions = paths.filter((path) => !existingPaths.has(path));
    for (
      let offset = 0;
      offset < Math.max(deletions.length, additions.length);
      offset += SYNC_BATCH_SIZE
    ) {
      if (!shouldContinue()) return false;
      const deleteBatch = deletions.slice(offset, offset + SYNC_BATCH_SIZE);
      const insertBatch = additions.slice(offset, offset + SYNC_BATCH_SIZE);
      this.transaction(() => {
        for (const path of deleteBatch) this.deleteIndexedRow(workspaceId, path);
        for (const path of insertBatch) this.insertIndexedRow(workspaceId, path);
      });
      if (offset + SYNC_BATCH_SIZE < Math.max(deletions.length, additions.length)) {
        await yieldToEventLoop();
      }
    }
    return shouldContinue();
  }

  insertPath(workspaceId: string, path: string): boolean {
    if (this.hasIndexedPath(workspaceId, path)) return false;
    return this.insertIndexedRow(workspaceId, path);
  }

  deletePath(workspaceId: string, path: string): boolean {
    return this.deleteIndexedRow(workspaceId, path);
  }

  async deleteSubtree(workspaceId: string, path: string): Promise<void> {
    const rows = sqlite
      .prepare(
        `SELECT path FROM workspace_file_index_rows
         WHERE workspace_id = ?
           AND (path = ? OR path LIKE ? ESCAPE '\\')`
      )
      .all(workspaceId, path, `${escapeSqliteLike(path)}/%`) as Array<{ path: string }>;

    for (let offset = 0; offset < rows.length; offset += SUBTREE_DELETE_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + SUBTREE_DELETE_BATCH_SIZE);
      this.transaction(() => {
        for (const row of batch) this.deleteIndexedRow(workspaceId, row.path);
      });
      if (offset + SUBTREE_DELETE_BATCH_SIZE < rows.length) await yieldToEventLoop();
    }
  }

  countIndexedFiles(workspaceId: string): number {
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM workspace_file_index_rows WHERE workspace_id = ?`)
      .get(workspaceId) as { count: number };
    return row.count;
  }

  /**
   * Dedicated file search for @-mention suggestions.
   *
   * Three branches by query length:
   *   - empty/whitespace  -> first `limit` files ordered by path (initial options)
   *   - 1-2 chars         -> LIKE %q% substring scan on filename and path
   *   - 3+ chars          -> trigram FTS MATCH (same as `search()`)
   */
  searchFiles(workspaceId: string, query: string, limit: number): FileHit[] {
    const trimmed = query.trim();

    if (!trimmed) {
      try {
        return sqlite
          .prepare(
            `SELECT path, filename FROM workspace_file_index_rows
             WHERE workspace_id = ?
             ORDER BY path
             LIMIT ?`
          )
          .all(workspaceId, limit) as FileHit[];
      } catch (e) {
        log.warn('WorkspaceFileIndexStore: searchFiles (empty) failed', {
          workspaceId,
          error: String(e),
        });
        return [];
      }
    }

    const hasLongTerm = trimmed.split(/[\s\-_/]+/).some((t) => t.length >= 3);

    if (!hasLongTerm) {
      const escaped = escapeSqliteLike(trimmed);
      const pattern = `%${escaped}%`;
      try {
        return sqlite
          .prepare(
            `SELECT path, filename FROM workspace_file_index_rows
             WHERE workspace_id = ?
               AND (filename LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')
             LIMIT ?`
          )
          .all(workspaceId, pattern, pattern, limit) as FileHit[];
      } catch (e) {
        log.warn('WorkspaceFileIndexStore: searchFiles (LIKE) failed', {
          workspaceId,
          error: String(e),
        });
        return [];
      }
    }

    return this.searchFts(workspaceId, trimmed, limit, 'searchFiles (FTS)');
  }

  search(workspaceId: string, query: string): FileHit[] {
    return this.searchFts(workspaceId, query, 20, 'search');
  }

  private searchFts(
    workspaceId: string,
    query: string,
    limit: number,
    logContext: string
  ): FileHit[] {
    const terms = query
      .trim()
      .split(/[\s\-_/]+/)
      .filter((t) => t.length >= 3);

    if (terms.length === 0) return [];

    const ftsQuery = terms.map((t) => `"${t}"`).join(' AND ');
    try {
      return sqlite
        .prepare(
          `SELECT rows.path, rows.filename
           FROM workspace_file_index
           JOIN workspace_file_index_rows rows ON rows.rowid = workspace_file_index.rowid
           WHERE workspace_file_index MATCH ?
             AND rows.workspace_id = ?
           ORDER BY bm25(workspace_file_index, 1.0, 2.0)
           LIMIT ?`
        )
        .all(ftsQuery, workspaceId, limit) as FileHit[];
    } catch (e) {
      log.warn(`WorkspaceFileIndexStore: ${logContext} failed`, {
        workspaceId,
        error: String(e),
      });
      return [];
    }
  }

  async deleteIndex(workspaceId: string): Promise<void> {
    try {
      await this.deleteWorkspaceRows(workspaceId);
      sqlite
        .prepare(`DELETE FROM workspace_file_index_meta WHERE workspace_id = ?`)
        .run(workspaceId);
      log.info('WorkspaceFileIndexStore: deleted index', { workspaceId });
    } catch (e) {
      log.warn('WorkspaceFileIndexStore: deleteIndex failed', { workspaceId, error: String(e) });
    }
  }

  async evict(staleDays: number): Promise<void> {
    await this.evictStale(staleDays);
    await this.evictOrphans();
  }

  private indexedPathSet(workspaceId: string): Set<string> {
    const rows = sqlite
      .prepare(`SELECT path FROM workspace_file_index_rows WHERE workspace_id = ?`)
      .all(workspaceId) as Array<{ path: string }>;
    return new Set(rows.map((row) => row.path));
  }

  private insertIndexedRow(workspaceId: string, path: string): boolean {
    const filename = basename(path);
    const result = this.statements.insertIdentity.run(workspaceId, path, filename);
    if (result.changes === 0) return false;

    this.statements.insertFts.run(Number(result.lastInsertRowid), workspaceId, path, filename);
    return true;
  }

  private deleteIndexedRow(workspaceId: string, path: string): boolean {
    const row = this.statements.selectIdentity.get(workspaceId, path) as
      | { rowid: number; workspace_id: string; path: string; filename: string }
      | undefined;
    if (!row) return false;

    this.statements.deleteFts.run(row.rowid, row.workspace_id, row.path, row.filename);
    this.statements.deleteIdentity.run(workspaceId, path);
    return true;
  }

  private hasIndexedPath(workspaceId: string, path: string): boolean {
    return Boolean(this.statements.hasIdentity.get(workspaceId, path));
  }

  private async evictStale(staleDays: number): Promise<void> {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - staleDays * 86400;
      const stale = sqlite
        .prepare(`SELECT workspace_id FROM workspace_file_index_meta WHERE indexed_at < ?`)
        .all(cutoff) as Array<{ workspace_id: string }>;

      if (stale.length === 0) return;

      for (const row of stale) {
        await this.deleteWorkspaceRows(row.workspace_id);
        sqlite
          .prepare(`DELETE FROM workspace_file_index_meta WHERE workspace_id = ?`)
          .run(row.workspace_id);
      }
      log.info('WorkspaceFileIndexStore: evicted stale indexes', { count: stale.length });
    } catch (e) {
      log.warn('WorkspaceFileIndexStore: evictStale failed', { error: String(e) });
    }
  }

  private async evictOrphans(): Promise<void> {
    try {
      const orphans = sqlite
        .prepare(
          `SELECT m.workspace_id
           FROM workspace_file_index_meta m
           LEFT JOIN workspaces w ON w.id = m.workspace_id
           WHERE w.id IS NULL`
        )
        .all() as Array<{ workspace_id: string }>;

      if (orphans.length === 0) return;

      for (const row of orphans) {
        await this.deleteWorkspaceRows(row.workspace_id);
        sqlite
          .prepare(`DELETE FROM workspace_file_index_meta WHERE workspace_id = ?`)
          .run(row.workspace_id);
      }

      log.info('WorkspaceFileIndexStore: evicted orphan indexes', { count: orphans.length });
    } catch (e) {
      log.warn('WorkspaceFileIndexStore: evictOrphans failed', { error: String(e) });
    }
  }

  private async deleteWorkspaceRows(workspaceId: string): Promise<void> {
    const rows = sqlite
      .prepare(`SELECT path FROM workspace_file_index_rows WHERE workspace_id = ?`)
      .all(workspaceId) as Array<{ path: string }>;
    for (let offset = 0; offset < rows.length; offset += SUBTREE_DELETE_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + SUBTREE_DELETE_BATCH_SIZE);
      this.transaction(() => {
        for (const row of batch) this.deleteIndexedRow(workspaceId, row.path);
      });
      if (offset + SUBTREE_DELETE_BATCH_SIZE < rows.length) await yieldToEventLoop();
    }
  }
}

function escapeSqliteLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isFileIndexStatus(value: string): value is FileIndexStatus {
  return value === 'complete' || value === 'stale' || value === 'truncated';
}

function isFileIndexTruncateReason(value: string | null): value is FileIndexTruncateReason {
  return value === 'maxEntries' || value === 'timeBudget';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
