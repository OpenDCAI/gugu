export const SCHEMA_VERSION = 1
export const EXTRACTOR_VERSION = 1

/** One database per account. Timestamps are UTC epoch microseconds; IDs stay in storage form. */
export const SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'topic')),
  source_chat_id TEXT
);
CREATE TABLE IF NOT EXISTS actor_scope (
  actor_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  floor_known INTEGER NOT NULL CHECK (floor_known IN (0, 1)),
  floor_at INTEGER,
  PRIMARY KEY (actor_id, chat_id)
);
CREATE TABLE IF NOT EXISTS msg (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  thread_root_id TEXT,
  seq INTEGER NOT NULL,
  sender_id TEXT,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  body TEXT NOT NULL,
  is_whisper INTEGER NOT NULL CHECK (is_whisper IN (0, 1)),
  to_user_ids TEXT NOT NULL,
  deleted_at INTEGER,
  has_file INTEGER NOT NULL CHECK (has_file IN (0, 1)),
  has_image INTEGER NOT NULL CHECK (has_image IN (0, 1)),
  has_link INTEGER NOT NULL CHECK (has_link IN (0, 1))
);
CREATE INDEX IF NOT EXISTS msg_chat_created ON msg(chat_id, created_at, seq);
CREATE INDEX IF NOT EXISTS msg_chat_stream_seq ON msg(chat_id, thread_root_id, seq);
-- A shared body is not an access grant. Missing/unknown hide metadata excludes the row.
CREATE TABLE IF NOT EXISTS msg_actor (
  actor_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES msg(id) ON DELETE CASCADE,
  from_history INTEGER NOT NULL CHECK (from_history IN (0, 1)),
  hidden_for_actor INTEGER CHECK (hidden_for_actor IN (0, 1)),
  PRIMARY KEY (actor_id, message_id)
);
-- detail=column cannot answer the required CJK phrase queries; offsets must be indexed.
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  body, content='msg', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2', detail=full
);
CREATE TRIGGER IF NOT EXISTS msg_fts_insert AFTER INSERT ON msg BEGIN
  INSERT INTO msg_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_delete AFTER DELETE ON msg BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_update AFTER UPDATE OF body ON msg BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO msg_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TABLE IF NOT EXISTS coverage (
  actor_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  ranges TEXT NOT NULL,
  oldest_at INTEGER,
  newest_at INTEGER,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  reasons TEXT NOT NULL CHECK (json_valid(reasons) AND json_type(reasons) = 'array'),
  PRIMARY KEY (actor_id, chat_id),
  CHECK ((complete = 1 AND json_array_length(reasons) = 0)
    OR (complete = 0 AND json_array_length(reasons) > 0))
);
`
