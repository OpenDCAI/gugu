export const SCHEMA_VERSION = 5
export const EXTRACTOR_VERSION = 2

/**
 * One database per account, holding only rows that account's own reads returned (the server already
 * applied visibility). Compare UTC epoch microseconds; preserve the original message ISO string.
 */
export const SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'ai', 'topic')),
  source_chat_id TEXT
);
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_user_id TEXT
);
CREATE TABLE IF NOT EXISTS task_coverage (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL,
  exhausted INTEGER NOT NULL CHECK (exhausted IN (0, 1))
);
CREATE TABLE IF NOT EXISTS msg (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT REFERENCES chat(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE CASCADE,
  message_ref TEXT,
  role TEXT CHECK (role IN ('user', 'assistant')),
  thread_root_id TEXT,
  seq INTEGER NOT NULL,
  sender_id TEXT,
  created_at INTEGER NOT NULL,
  created_at_iso TEXT NOT NULL,
  text TEXT NOT NULL,
  is_whisper INTEGER NOT NULL CHECK (is_whisper IN (0, 1)),
  to_user_ids TEXT NOT NULL,
  has_file INTEGER NOT NULL CHECK (has_file IN (0, 1)),
  has_image INTEGER NOT NULL CHECK (has_image IN (0, 1)),
  has_link INTEGER NOT NULL CHECK (has_link IN (0, 1)),
  CHECK ((chat_id IS NULL) <> (task_id IS NULL))
);
CREATE INDEX IF NOT EXISTS msg_chat_created ON msg(chat_id, created_at, seq);
CREATE INDEX IF NOT EXISTS msg_chat_stream_seq ON msg(chat_id, thread_root_id, seq);
-- detail=column cannot answer the required CJK phrase queries; offsets must be indexed.
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  body, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2', detail=full
);
CREATE TRIGGER IF NOT EXISTS msg_fts_delete AFTER DELETE ON msg BEGIN
  DELETE FROM msg_fts WHERE rowid = old.rowid;
END;
CREATE INDEX IF NOT EXISTS msg_task_seq ON msg(task_id, seq);
-- '' is the main timeline; otherwise the thread root id.
CREATE TABLE IF NOT EXISTS coverage (
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  stream TEXT NOT NULL,
  oldest_seq INTEGER,
  newest_seq INTEGER,
  exhausted INTEGER NOT NULL CHECK (exhausted IN (0, 1)),
  PRIMARY KEY (chat_id, stream)
);
`

/** Tables of every schema version, dropped when the stored version differs. */
export const SEARCH_SCHEMA_DROP_SQL = `
DROP TRIGGER IF EXISTS msg_fts_insert; DROP TRIGGER IF EXISTS msg_fts_delete; DROP TRIGGER IF EXISTS msg_fts_update;
DROP TABLE IF EXISTS msg_fts; DROP TABLE IF EXISTS msg_actor; DROP TABLE IF EXISTS msg;
DROP TABLE IF EXISTS task_coverage; DROP TABLE IF EXISTS task;
DROP TABLE IF EXISTS coverage; DROP TABLE IF EXISTS actor_scope; DROP TABLE IF EXISTS chat;
DELETE FROM search_meta;
`
