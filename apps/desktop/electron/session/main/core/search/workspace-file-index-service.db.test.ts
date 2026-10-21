import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceFileEnumerator,
  WorkspaceFileIndexServiceOptions,
} from './workspace-file-index-service';

type LoadedService = Awaited<ReturnType<typeof loadService>>;
type FileIndexMetaRow = {
  root_path: string;
  status: string;
  file_count: number;
  truncate_reason: string | null;
};

let loadedService: LoadedService | undefined;

describe('WorkspaceFileIndexService', () => {
  afterEach(async () => {
    vi.useRealTimers();
    loadedService?.service.onWorkspaceDeactivated('ws-1');
    loadedService?.sqlite.close();
    if (loadedService) {
      await rm(loadedService.tempDir, { recursive: true, force: true });
    }
    loadedService = undefined;
    vi.resetModules();
    delete process.env.GUGU_SESSION_DB_FILE;
  });

  it('indexes files from core enumeration when a workspace is activated', async () => {
    loadedService = await loadService();
    const { service, sqlite } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/README.md', '/repo/src/index.ts']),
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/README.md', '/repo/src/index.ts']);
    expect(indexMeta(sqlite)).toEqual({
      root_path: '/repo',
      status: 'complete',
      file_count: 2,
      truncate_reason: null,
    });
    expect(service.search('ws-1', 'index')).toEqual([
      { path: '/repo/src/index.ts', filename: 'index.ts' },
    ]);
  });

  it('searches file mention candidates for empty, short, and FTS queries', async () => {
    loadedService = await loadService();
    const { service } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/README.md', '/repo/package.json', '/repo/src/index.ts']),
    });

    expect(service.searchFiles('ws-1', '', 2)).toEqual([
      { path: '/repo/README.md', filename: 'README.md' },
      { path: '/repo/package.json', filename: 'package.json' },
    ]);
    expect(service.searchFiles('ws-1', 'in', 5)).toEqual([
      { path: '/repo/src/index.ts', filename: 'index.ts' },
    ]);
    expect(service.searchFiles('ws-1', 'package', 5)).toEqual([
      { path: '/repo/package.json', filename: 'package.json' },
    ]);
  });

  it('applies path-changing file events incrementally', async () => {
    loadedService = await loadService();
    const { service, sqlite } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/src/changed.ts', '/repo/src/old.ts']),
    });

    await service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [
        { kind: 'create', path: '/repo/src/new.ts', entryType: 'file' },
        { kind: 'update', path: '/repo/src/changed.ts', entryType: 'file' },
        { kind: 'update', path: '/repo/src/missing.ts', entryType: 'file' },
        { kind: 'delete', path: '/repo/src/old.ts', entryType: 'file' },
      ],
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/src/changed.ts', '/repo/src/new.ts']);
    expect(indexMeta(sqlite)).toMatchObject({ status: 'complete', file_count: 2 });
  });

  it('removes descendants when a directory-like path is deleted', async () => {
    loadedService = await loadService();
    const { service, sqlite } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/other.ts', '/repo/src/a.ts', '/repo/src/nested/b.ts']),
    });

    await service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [{ kind: 'delete', path: '/repo/src', entryType: 'unknown' }],
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/other.ts']);
    expect(indexMeta(sqlite)).toMatchObject({ status: 'complete', file_count: 1 });
  });

  it('reindexes from core enumeration on resync', async () => {
    vi.useFakeTimers();
    loadedService = await loadService({ reindexDebounceMs: 1 });
    const { service, sqlite } = loadedService;
    let paths = ['/repo/stale.ts'];

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => paths),
    });
    expect(indexedPaths(sqlite)).toEqual(['/repo/stale.ts']);

    paths = ['/repo/fresh.ts'];
    service.onWorkspaceFileChange('ws-1', { kind: 'resync' });
    await vi.advanceTimersByTimeAsync(1);

    expect(indexedPaths(sqlite)).toEqual(['/repo/fresh.ts']);
    expect(indexMeta(sqlite)).toMatchObject({ status: 'complete', file_count: 1 });
  });

  it('records truncated full indexes as incomplete', async () => {
    loadedService = await loadService({ maxFiles: 2 });
    const { service, sqlite } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']),
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(indexMeta(sqlite)).toEqual({
      root_path: '/repo',
      status: 'truncated',
      file_count: 2,
      truncate_reason: 'maxEntries',
    });

    await service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [{ kind: 'create', path: '/repo/d.ts', entryType: 'file' }],
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(indexMeta(sqlite)).toMatchObject({ status: 'truncated', file_count: 2 });
  });

  it('rebuilds a truncated snapshot on activation to refresh its contents', async () => {
    loadedService = await loadService({ maxFiles: 1 });
    const { service } = loadedService;
    let enumerations = 0;

    const source = {
      rootPath: '/repo',
      enumerate: (_rootPath: string) => {
        enumerations += 1;
        return {
          success: true as const,
          data: (async function* () {
            yield '/repo/a.ts';
            yield '/repo/b.ts';
          })(),
        };
      },
    };

    await service.onWorkspaceActivated('ws-1', source);
    await service.onWorkspaceActivated('ws-1', source);

    expect(enumerations).toBe(2);
  });

  it('serializes unawaited watcher updates for one workspace', async () => {
    loadedService = await loadService({ maxFiles: 2_000, reindexDebounceMs: 0 });
    const { service, sqlite } = loadedService;
    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => []),
    });

    const creates = Array.from({ length: 751 }, (_, index) => ({
      kind: 'create' as const,
      path: `/repo/${index === 0 ? 'a' : `file-${index}`}.ts`,
      entryType: 'file' as const,
    }));
    const first = service.onWorkspaceFileChange('ws-1', { kind: 'changes', changes: creates });
    const second = service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [{ kind: 'delete', path: '/repo/a.ts', entryType: 'file' }],
    });
    await Promise.all([first, second]);

    expect(indexedPaths(sqlite)).not.toContain('/repo/a.ts');
    expect(indexedPaths(sqlite)).toHaveLength(750);
  });

  it('lets a queued reindex finish before a queued incremental update', async () => {
    loadedService = await loadService({ maxFiles: 2_000, reindexDebounceMs: 0 });
    const { service, sqlite } = loadedService;
    let paths = ['/repo/old.ts'];
    let reindexing = false;
    let releaseReindex: (() => void) | undefined;
    let reindexStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reindexStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });
    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: () => {
        if (!reindexing) {
          return enumerator(() => paths)('/repo');
        }
        return {
          success: true as const,
          data: (async function* () {
            reindexStarted?.();
            await gate;
            yield* paths;
          })(),
        };
      },
    });

    paths = ['/repo/fresh.ts'];
    reindexing = true;
    const resync = service.onWorkspaceFileChange('ws-1', { kind: 'resync' });
    await resync;
    await started;
    const update = service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [{ kind: 'create', path: '/repo/after.ts', entryType: 'file' }],
    });
    releaseReindex?.();
    await update;

    expect(indexedPaths(sqlite)).toEqual(['/repo/after.ts', '/repo/fresh.ts']);
  });

  it('yields to the event loop between sync batches', async () => {
    loadedService = await loadService({ maxFiles: 2_000 });
    const { service } = loadedService;
    const paths = Array.from({ length: 1_001 }, (_, index) => `/repo/file-${index}.ts`);
    const order: string[] = [];
    const probe = new Promise<void>((resolve) => {
      setImmediate(() => {
        order.push('probe');
        resolve();
      });
    });

    const activation = service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => paths),
    });
    activation.then(() => order.push('resolve'));
    await Promise.all([activation, probe]);
    expect(order[0]).toBe('probe');
  });

  it('does not grow a complete index past the file cap', async () => {
    loadedService = await loadService({ maxFiles: 2 });
    const { service, sqlite } = loadedService;

    await service.onWorkspaceActivated('ws-1', {
      rootPath: '/repo',
      enumerate: enumerator(() => ['/repo/a.ts', '/repo/b.ts']),
    });

    await service.onWorkspaceFileChange('ws-1', {
      kind: 'changes',
      changes: [{ kind: 'create', path: '/repo/c.ts', entryType: 'file' }],
    });

    expect(indexedPaths(sqlite)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(indexMeta(sqlite)).toMatchObject({ status: 'stale', file_count: 2 });
  });

  it('keeps path identity in a keyed table rather than the FTS virtual table', async () => {
    loadedService = await loadService();
    const { sqlite, sql } = loadedService;

    const keyedPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         ${sql.selectIdentity}`
      )
      .all('ws-1', '/repo/a.ts') as Array<{ detail: string }>;
    expect(keyedPlan.map((row) => row.detail).join(' ')).toMatch(
      /USING INDEX|USING COVERING INDEX/
    );

    const deletePlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql.deleteIdentity}`)
      .all('ws-1', '/repo/a.ts') as Array<{ detail: string }>;
    expect(deletePlan.map((row) => row.detail).join(' ')).toMatch(
      /USING INDEX|USING COVERING INDEX/
    );
    expect(sql.insertIdentity + sql.selectIdentity + sql.deleteIdentity).not.toMatch(
      /workspace_file_index\b/
    );

    sqlite.exec(`
      CREATE VIRTUAL TABLE legacy_workspace_file_index USING fts5(
        workspace_id UNINDEXED, path, filename,
        tokenize = 'trigram case_sensitive 0'
      );
    `);
    const legacyPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT rowid FROM legacy_workspace_file_index WHERE workspace_id = ? AND path = ?`
      )
      .all('ws-1', '/repo/a.ts') as Array<{ detail: string }>;
    expect(legacyPlan.map((row) => row.detail).join(' ')).toMatch(/SCAN/);
  });
});

async function loadService(options: WorkspaceFileIndexServiceOptions = {}) {
  vi.resetModules();
  const tempDir = await mkdtemp(join(tmpdir(), 'emdash-file-index-'));
  process.env.GUGU_SESSION_DB_FILE = join(tempDir, 'test.db');

  const [{ WorkspaceFileIndexService }, { sqlite }, { WORKSPACE_FILE_INDEX_SQL }] = await Promise.all([
    import('./workspace-file-index-service'),
    import('@main/db/client'),
    import('./workspace-file-index-store'),
  ]);
  createFileIndexTables(sqlite);

  return {
    service: new WorkspaceFileIndexService(options),
    sql: WORKSPACE_FILE_INDEX_SQL,
    sqlite,
    tempDir,
  };
}

function createFileIndexTables(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE workspace_file_index_rows (
      rowid        INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      path         TEXT NOT NULL,
      filename     TEXT NOT NULL,
      UNIQUE(workspace_id, path)
    );
    CREATE VIRTUAL TABLE workspace_file_index USING fts5(
      workspace_id UNINDEXED,
      path,
      filename,
      tokenize = 'trigram case_sensitive 0',
      content = ''
    );
    CREATE TABLE workspace_file_index_meta (
      workspace_id     TEXT PRIMARY KEY,
      indexed_at       INTEGER NOT NULL,
      root_path        TEXT NOT NULL,
      status           TEXT NOT NULL
        CHECK (status IN ('complete', 'stale', 'truncated')),
      file_count       INTEGER NOT NULL,
      truncate_reason  TEXT
        CHECK (truncate_reason IS NULL OR truncate_reason IN ('maxEntries', 'timeBudget'))
    );
  `);
}

function enumerator(readPaths: () => readonly string[]): WorkspaceFileEnumerator {
  return () => ({
    success: true as const,
    data: (async function* () {
      for (const path of readPaths()) {
        yield path;
      }
    })(),
  });
}

function indexedPaths(sqlite: BetterSqlite3.Database): string[] {
  return (
    sqlite.prepare(`SELECT path FROM workspace_file_index_rows ORDER BY path`).all() as Array<{
      path: string;
    }>
  ).map((row) => row.path);
}

function indexMeta(sqlite: BetterSqlite3.Database): FileIndexMetaRow | undefined {
  return sqlite
    .prepare(
      `SELECT root_path, status, file_count, truncate_reason
       FROM workspace_file_index_meta
       WHERE workspace_id = 'ws-1'`
    )
    .get() as FileIndexMetaRow | undefined;
}
