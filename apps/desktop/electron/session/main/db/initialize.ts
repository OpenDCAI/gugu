import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import journal from '@root/drizzle/meta/_journal.json';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';

// Vite bundles all migration SQL files at build time — no runtime path resolution needed.
// Each value is the raw SQL string content of the file.
const sqlFiles = import.meta.glob('@root/drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };
export type PendingMigration = { tag: string; when: number; sql: string };

export function bundledMigrations(): PendingMigration[] {
  return (journal as { entries: JournalEntry[] }).entries.map((entry) => {
    const sqlKey = Object.keys(sqlFiles).find((k) => k.includes(entry.tag));
    if (!sqlKey) throw new Error(`Missing bundled SQL for migration: ${entry.tag}`);
    return { tag: entry.tag, when: entry.when, sql: sqlFiles[sqlKey] };
  });
}

/**
 * Applies every migration newer than the last recorded one, all in one transaction.
 *
 * @@@foreign-keys-off - `PRAGMA foreign_keys` is a no-op inside a transaction, so the `PRAGMA
 * foreign_keys=OFF` that drizzle-kit writes into table-rebuild migrations never took effect here: the
 * `DROP TABLE <old>` of a rebuild then runs its implicit DELETE with cascades on and empties every child
 * table pointing at it. Enforcement is therefore switched off around the transaction, and the result is
 * checked with `foreign_key_check` before commit: a violation the batch introduced throws and rolls the
 * whole batch back. Violations already in the database before the batch are not the batch's doing
 * (columns added by `ALTER TABLE … REFERENCES` never validated old rows), so they don't block it.
 */
export function applyMigrations(
  connection: BetterSqlite3.Database,
  migrations: readonly PendingMigration[]
): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const lastRow = connection
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: number } | undefined;
  const lastTimestamp = lastRow?.created_at ?? 0;
  const pending = migrations.filter((migration) => migration.when > lastTimestamp);
  if (pending.length === 0) return;

  // Counted per child→parent pair, not per row: a rebuilt table gets new rowids, so a row-level diff would
  // report every old violation in it as new.
  const violations = () => {
    const counts = new Map<string, number>();
    for (const row of connection.pragma('foreign_key_check') as { table: string; parent: string }[]) {
      const pair = `${row.table}→${row.parent}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const enforced = connection.pragma('foreign_keys', { simple: true }) === 1;
  connection.pragma('foreign_keys = OFF');
  try {
    connection.transaction(() => {
      const before = violations();
      for (const migration of pending) {
        for (const stmt of migration.sql.split('--> statement-breakpoint')) {
          const trimmed = stmt.trim();
          if (trimmed) connection.exec(trimmed);
        }
        connection
          .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          .run(createHash('sha256').update(migration.sql).digest('hex'), migration.when);
      }
      const introduced = [...violations()]
        .filter(([pair, n]) => n > (before.get(pair) ?? 0))
        .map(([pair, n]) => `${pair}: ${before.get(pair) ?? 0} → ${n}`);
      if (introduced.length > 0) {
        throw new Error(
          `Migrations ${pending.map((m) => m.tag).join(', ')} introduced foreign key violations (${introduced.join('; ')})`
        );
      }
    })();
  } finally {
    if (enforced) connection.pragma('foreign_keys = ON');
  }
}

/**
 * Creates the FTS5 full-text search virtual table used by the command palette.
 * This is managed outside the Drizzle migration system because Drizzle cannot
 * generate FTS5 virtual table DDL. The table is version-gated via the `kv`
 * table so it can be safely dropped and recreated when the schema changes.
 */
function ensureSearchIndex(connection: BetterSqlite3.Database): void {
  // Bump this version string whenever the FTS schema changes — the table is
  // dropped and recreated, and backfill() + seedCommands() repopulate it.
  const SEARCH_INDEX_VERSION = '6';

  const row = connection.prepare(`SELECT value FROM kv WHERE key = 'fts_version'`).get() as
    | { value: string }
    | undefined;

  if (row?.value !== SEARCH_INDEX_VERSION) {
    connection.exec(`DROP TABLE IF EXISTS search_index`);
    ensureTurnText(connection);
    connection.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        item_type,
        item_id    UNINDEXED,
        project_id UNINDEXED,
        title,
        keywords,
        tokenize = 'trigram case_sensitive 0'
      )
    `);
    connection
      .prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('fts_version', ?, unixepoch())`
      )
      .run(SEARCH_INDEX_VERSION);
  }
}

/**
 * Task conversation text for search, derived from session_turns by triggers: every writer of a turn (live, replay,
 * revision, record append, truncation, session cascade) updates it in the same transaction, and nothing else writes it.
 * Only message items (what the person and the agent said, through `search_text`) are kept; thinking and tools are not searchable.
 * `turn_text_rows` holds them keyed by (session_id, seq); `turn_text` is its trigram FTS5 index (external content).
 * Rebuilt with the search index version, including a backfill of the existing turns.
 */
/**
 * `search_text(text)`: what a person reads in a message item, for turn_text — a delivery's body (its envelope is how
 * it arrived, not what was said; read by the envelope module's one reader), nothing for the silence marker. Registered on
 * the connection before migrations, because the session_turns triggers call it on every turn write.
 */
function registerSearchText(connection: BetterSqlite3.Database): void {
  connection.function('search_text', { deterministic: true }, (text: unknown) => {
    if (typeof text !== 'string' || isGuguSilence(text)) return null;
    return readDeliveryEnvelope(text)?.body ?? text;
  });
}

function ensureTurnText(connection: BetterSqlite3.Database): void {
  const messages = (turn: string) => `SELECT ${turn}.session_id, ${turn}.seq, json_extract(item.value, '$.id'), json_extract(item.value, '$.role'),
      search_text(json_extract(item.value, '$.text')) FROM json_each(${turn}.data, '$.items') AS item
    WHERE json_extract(item.value, '$.kind') = 'message' AND length(search_text(json_extract(item.value, '$.text'))) > 0`;
  connection.exec(`
    DROP TRIGGER IF EXISTS session_turns_text_insert;
    DROP TRIGGER IF EXISTS session_turns_text_update;
    DROP TRIGGER IF EXISTS session_turns_text_delete;
    DROP TABLE IF EXISTS turn_text;
    DROP TABLE IF EXISTS turn_text_rows;
    CREATE TABLE turn_text_rows (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      item_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX turn_text_rows_turn ON turn_text_rows (session_id, seq);
    CREATE VIRTUAL TABLE turn_text USING fts5(text, content = 'turn_text_rows', content_rowid = 'id', tokenize = 'trigram case_sensitive 0');
    CREATE TRIGGER turn_text_rows_insert AFTER INSERT ON turn_text_rows BEGIN
      INSERT INTO turn_text (rowid, text) VALUES (NEW.id, NEW.text);
    END;
    CREATE TRIGGER turn_text_rows_delete AFTER DELETE ON turn_text_rows BEGIN
      INSERT INTO turn_text (turn_text, rowid, text) VALUES ('delete', OLD.id, OLD.text);
    END;
    CREATE TRIGGER session_turns_text_insert AFTER INSERT ON session_turns BEGIN
      INSERT INTO turn_text_rows (session_id, seq, item_id, role, text) ${messages('NEW')};
    END;
    CREATE TRIGGER session_turns_text_update AFTER UPDATE OF data ON session_turns BEGIN
      DELETE FROM turn_text_rows WHERE session_id = OLD.session_id AND seq = OLD.seq;
      INSERT INTO turn_text_rows (session_id, seq, item_id, role, text) ${messages('NEW')};
    END;
    CREATE TRIGGER session_turns_text_delete AFTER DELETE ON session_turns BEGIN
      DELETE FROM turn_text_rows WHERE session_id = OLD.session_id AND seq = OLD.seq;
    END;
    INSERT INTO turn_text_rows (session_id, seq, item_id, role, text) ${messages('t').replace('FROM json_each', 'FROM session_turns AS t, json_each')};
  `);
}

/**
 * Creates the keyed identity table, FTS5 virtual table, and companion meta
 * table used for workspace file indexing. Managed outside Drizzle (same reason
 * as ensureSearchIndex).
 * Version-gated via `kv` so the tables can be dropped and recreated on schema
 * changes without a full Drizzle migration.
 */
function ensureFileIndex(connection: BetterSqlite3.Database): void {
  const FILE_INDEX_VERSION = '5';

  const row = connection.prepare(`SELECT value FROM kv WHERE key = 'file_index_version'`).get() as
    | { value: string }
    | undefined;

  if (row?.value === FILE_INDEX_VERSION) return;

  connection.exec(`DROP TABLE IF EXISTS workspace_file_index`);
  connection.exec(`DROP TABLE IF EXISTS workspace_file_index_rows`);
  connection.exec(`DROP TABLE IF EXISTS workspace_file_index_meta`);
  connection.exec(`
    CREATE TABLE workspace_file_index_rows (
      rowid        INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      path         TEXT NOT NULL,
      filename     TEXT NOT NULL,
      UNIQUE(workspace_id, path)
    );
  `);
  connection.exec(`
    CREATE VIRTUAL TABLE workspace_file_index USING fts5(
      workspace_id UNINDEXED,
      path,
      filename,
      tokenize = 'trigram case_sensitive 0',
      content = ''
    )
  `);
  connection.exec(`
    CREATE TABLE workspace_file_index_meta (
      workspace_id     TEXT PRIMARY KEY,
      indexed_at       INTEGER NOT NULL,
      root_path        TEXT NOT NULL,
      status           TEXT NOT NULL
        CHECK (status IN ('complete', 'stale', 'truncated')),
      file_count       INTEGER NOT NULL,
      truncate_reason  TEXT
        CHECK (truncate_reason IS NULL OR truncate_reason IN ('maxEntries', 'timeBudget'))
    )
  `);
  connection
    .prepare(
      `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('file_index_version', ?, unixepoch())`
    )
    .run(FILE_INDEX_VERSION);
}

/**
 * Runs all pending migrations against the provided SQLite connection (or the
 * app's shared singleton when called without arguments). Call this once in
 * main.ts before any db queries run.
 *
 * Accepts an explicit connection so migration tests and fixture generators can
 * pass an in-memory database without pulling in the Electron-dependent client
 * module at import time.
 *
 * Returns the connection that was used.
 */
export async function initializeDatabase(
  connection?: BetterSqlite3.Database
): Promise<BetterSqlite3.Database> {
  // Lazily import the app singleton only when no explicit connection is given.
  // This keeps the module importable in non-Electron environments (Vitest).
  const conn = connection ?? (await import('./client')).sqlite;
  conn.pragma('foreign_keys = ON');
  registerSearchText(conn);
  applyMigrations(conn, bundledMigrations());
  ensureSearchIndex(conn);
  ensureFileIndex(conn);
  return conn;
}
