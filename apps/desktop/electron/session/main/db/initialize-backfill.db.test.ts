import Database from 'better-sqlite3';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import * as initialization from './initialize';

let fixture: FixtureDb;
const sqlite = () => fixture.sqlite;
const rows = (db = sqlite()) => db.prepare(
  'SELECT session_id, seq, item_id, role, text FROM turn_text_rows ORDER BY session_id, seq, item_id'
).all();
const value = (key: string, db = sqlite()) =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const schema = () => sqlite().prepare(
  "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
).all();

function turn(session: string, seq: number, text = `historical ${session} ${seq}`): string {
  const id = `${session}:turn:${seq}`;
  return JSON.stringify({ id, referenceId: `source:${session}:${seq}`, items: [
    { kind: 'message', id: `${id}:message:0`, role: 'user', text },
    { kind: 'thinking', id: `${id}:thinking:0`, text: 'not searchable' },
    { kind: 'tool-call', id: `${id}:tool:0`, name: 'fixture' },
    { kind: 'message', id: `${id}:message:1`, role: 'assistant', text: `answer ${text}` },
  ] });
}

function insert(session: string, seq: number, data = turn(session, seq)): void {
  sqlite().prepare('INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES (?, ?, ?, ?, ?)')
    .run(`${session}:${seq}`, session, seq, `turn-${seq}`, data);
}

// The pre-source-identity v7 triggers (80e610909^): an old reader registers search_text only.
const legacyMessages = (alias: string) => `SELECT ${alias}.session_id, ${alias}.seq,
  json_extract(item.value, '$.id'), json_extract(item.value, '$.role'), search_text(json_extract(item.value, '$.text'))
  FROM json_each(iif(json_valid(${alias}.data), ${alias}.data, '{}'), '$.items') item
  WHERE json_extract(item.value, '$.kind') = 'message' AND length(search_text(json_extract(item.value, '$.text'))) > 0`;

function legacy(size = 3): void {
  sqlite().transaction(() => {
    // Stored rowids run in the opposite order to the stable (session_id, seq) cursor.
    for (let n = size - 1; n >= 0; n--) {
      const session = n % 2 === 0 ? 'a' : 'z';
      insert(session, Math.floor(n / 2), n % 11 === 0 ? 'not json' : turn(session, Math.floor(n / 2)));
    }
    sqlite().exec(`
      DROP TRIGGER session_turns_text_insert;
      DROP TRIGGER session_turns_text_update;
      DROP TRIGGER session_turns_text_delete;
      CREATE TRIGGER session_turns_text_insert AFTER INSERT ON session_turns BEGIN
        INSERT INTO turn_text_rows(session_id, seq, item_id, role, text) ${legacyMessages('NEW')};
      END;
      CREATE TRIGGER session_turns_text_update AFTER UPDATE OF data ON session_turns BEGIN
        DELETE FROM turn_text_rows WHERE session_id = OLD.session_id AND seq = OLD.seq;
        INSERT INTO turn_text_rows(session_id, seq, item_id, role, text) ${legacyMessages('NEW')};
      END;
      CREATE TRIGGER session_turns_text_delete AFTER DELETE ON session_turns BEGIN
        DELETE FROM turn_text_rows WHERE session_id = OLD.session_id AND seq = OLD.seq;
      END;
      DELETE FROM turn_text_rows;
      INSERT INTO turn_text_rows(session_id, seq, item_id, role, text)
        ${legacyMessages('t').replace('FROM json_each', 'FROM session_turns t, json_each')};
      UPDATE kv SET value = '7' WHERE key = 'fts_version';
      INSERT INTO search_index(item_type, item_id, title, keywords) VALUES ('command', 'legacy-command', 'old search', '');
    `);
  })();
}

function snapshot() {
  return {
    schema: schema(),
    kv: sqlite().prepare('SELECT * FROM kv ORDER BY key').all(),
    search: sqlite().prepare('SELECT * FROM search_index ORDER BY item_id').all(),
    text: rows(),
    files: sqlite().prepare('SELECT * FROM workspace_file_index_rows ORDER BY rowid').all(),
    meta: sqlite().prepare('SELECT * FROM workspace_file_index_meta ORDER BY workspace_id').all(),
    turns: sqlite().prepare('SELECT * FROM session_turns ORDER BY session_id, seq').all(),
  };
}

// Resolve from the existing module so parent tests still exercise real DDL before this new API exists.
const fill = (db = sqlite()): Promise<void> => {
  const backfill: unknown = Reflect.get(initialization, 'backfillTurnText');
  expect(backfill, 'post-ready turn-text backfill entry point').toBeTypeOf('function');
  return (backfill as (connection: Database.Database) => Promise<void>)(db);
};

function expected(db = sqlite()) {
  // The original one-shot v8 projection is the oracle for pagination and interleaved trigger writes.
  return db.prepare(`SELECT t.session_id, t.seq,
    message_reference(json_extract(t.data, '$.id'), json_extract(t.data, '$.referenceId'), json_extract(item.value, '$.id')) item_id,
    json_extract(item.value, '$.role') role, search_text(json_extract(item.value, '$.text')) text
    FROM session_turns t, json_each(iif(json_valid(t.data), t.data, '{}'), '$.items') item
    WHERE json_extract(item.value, '$.kind') = 'message' AND length(search_text(json_extract(item.value, '$.text'))) > 0
    ORDER BY t.session_id, t.seq, item_id`).all();
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  sqlite().exec(`INSERT INTO projects(id, name, path) VALUES ('p', 'Project', '/repo');
    INSERT INTO sessions(id, project_id, config) VALUES ('a', 'p', '{"version":"1","type":"acp"}'), ('z', 'p', '{"version":"1","type":"acp"}');`);
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
});

describe('derived-index structure rebuilds are atomic', () => {
  it.each(['DROP TABLE IF EXISTS search_index', 'CREATE TABLE turn_text_rows', 'CREATE VIRTUAL TABLE search_index'])(
    'leaves the entire v7 state intact after interruption at %s', async (point) => {
      legacy();
      const before = snapshot();
      const exec = sqlite().exec.bind(sqlite());
      const fault = vi.spyOn(sqlite(), 'exec').mockImplementation((sql) => {
        const result = exec(sql);
        if (sql.includes(point)) throw new Error('interrupted structure rebuild');
        return result;
      });
      await expect(initialization.initializeDatabase(sqlite())).rejects.toThrow('interrupted structure rebuild');
      fault.mockRestore();
      expect(schema()).toEqual(before.schema);
      expect(snapshot()).toEqual(before);
      const oldReader = new Database(sqlite().name);
      try {
        oldReader.function('search_text', { deterministic: true }, (text: string) => text);
        expect(() => oldReader.prepare("DELETE FROM search_index WHERE item_type='command'").run()).not.toThrow();
        expect(() => oldReader.prepare('INSERT INTO session_turns(id, session_id, seq, turn_id, data) VALUES (?, ?, ?, ?, ?)')
          .run('old-reader', 'a', 999, 'old-reader', turn('a', 999))).not.toThrow();
      } finally { oldReader.close(); }
    }
  );

  it.each(['fts_version', 'file_index_version'])('rolls back all DDL and data when writing %s fails', async (key) => {
    if (key === 'fts_version') legacy();
    else {
      sqlite().exec(`UPDATE kv SET value='4' WHERE key='file_index_version';
        INSERT INTO workspace_file_index_rows(rowid, workspace_id, path, filename) VALUES (1, 'w', 'legacy.txt', 'legacy.txt');
        INSERT INTO workspace_file_index(rowid, workspace_id, path, filename) VALUES (1, 'w', 'legacy.txt', 'legacy.txt');
        INSERT INTO workspace_file_index_meta(workspace_id,indexed_at,root_path,status,file_count) VALUES ('w',1,'/repo','complete',1);`);
    }
    sqlite().exec(`CREATE TRIGGER interrupt_version BEFORE INSERT ON kv WHEN NEW.key='${key}'
      BEGIN SELECT RAISE(ABORT, 'interrupted version write'); END;`);
    const before = snapshot();
    await expect(initialization.initializeDatabase(sqlite())).rejects.toThrow('interrupted version write');
    expect(schema()).toEqual(before.schema);
    expect(snapshot()).toEqual(before);
    if (key === 'file_index_version') {
      expect(sqlite().prepare("SELECT rowid FROM workspace_file_index WHERE workspace_file_index MATCH 'legacy'").all())
        .toEqual([{ rowid: 1 }]);
    }
  });
});

describe('post-ready turn-text backfill', () => {
  it('commits at most one 64-turn chunk before releasing the lock for live writers', async () => {
    legacy(401);
    await initialization.initializeDatabase(sqlite());
    const filling = fill();
    try {
      await setImmediate();
      const saved = value('turn_text_backfill_cursor');
      expect(saved).toBeDefined();
      const cursor = JSON.parse(saved!) as [string, number];
      const committed = sqlite().prepare('SELECT count(*) n FROM session_turns WHERE (session_id,seq) <= (?,?)').get(...cursor);
      expect(committed).toEqual({ n: 64 });
      expect(value('turn_text_backfilled')).toBeUndefined();
      const live = new Database(sqlite().name, { timeout: 0 });
      try {
        live.prepare("INSERT INTO kv(key,value,updated_at) VALUES ('inbox-lock-probe','committed',0)").run();
      } finally { live.close(); }
    } finally { await filling; }
    expect(rows()).toEqual(expected());
  });

  it('creates every search table without reading historical messages in initializeDatabase', async () => {
    legacy(401);
    await initialization.initializeDatabase(sqlite());
    expect(rows()).toEqual([]);
    expect(value('fts_version')).toBe('9');
    expect(() => sqlite().prepare("SELECT rowid FROM search_index WHERE search_index MATCH 'historical'").all()).not.toThrow();
    expect(() => sqlite().prepare("SELECT rowid FROM turn_text WHERE turn_text MATCH 'historical'").all()).not.toThrow();
  });

  it('rolls batch writes back with a failed cursor write, then restarts without duplicates', async () => {
    legacy(401);
    await initialization.initializeDatabase(sqlite());
    expect(rows()).toEqual([]);
    sqlite().exec(`CREATE TRIGGER interrupt_cursor BEFORE INSERT ON kv WHEN NEW.key='turn_text_backfill_cursor'
      BEGIN SELECT RAISE(ABORT, 'cursor write failed'); END;`);
    await expect(fill()).rejects.toThrow('cursor write failed');
    expect(rows()).toEqual([]);
    expect(value('turn_text_backfill_cursor')).toBeUndefined();
    expect(value('turn_text_backfilled')).toBeUndefined();
    sqlite().exec('DROP TRIGGER interrupt_cursor');
    await fill();
    expect(rows()).toEqual(expected());
    expect(value('turn_text_backfilled')).toBe('9');
    expect(value('turn_text_backfill_cursor')).toBeUndefined();
    await fill();
    expect(rows()).toEqual(expected());
  });

  it('persists a completed batch and resumes by stable keys after interruption and VACUUM', async () => {
    legacy(401);
    await initialization.initializeDatabase(sqlite());
    expect(rows()).toEqual([]);
    sqlite().exec(`CREATE TRIGGER interrupt_second_batch BEFORE INSERT ON kv
      WHEN NEW.key='turn_text_backfill_cursor' AND EXISTS(SELECT 1 FROM kv WHERE key='turn_text_backfill_cursor')
      BEGIN SELECT RAISE(ABORT, 'second batch interrupted'); END;`);
    await expect(fill()).rejects.toThrow('second batch interrupted');
    const cursor = value('turn_text_backfill_cursor');
    const partial = rows();
    expect(cursor).toBeDefined();
    expect(JSON.parse(cursor!)).toEqual([expect.any(String), expect.any(Number)]);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(expected().length);
    const restarted = new Database(sqlite().name);
    try {
      expect(value('turn_text_backfill_cursor', restarted)).toBe(cursor);
      expect(rows(restarted)).toEqual(partial);
      restarted.exec("DROP TRIGGER interrupt_second_batch; DELETE FROM session_turns WHERE session_id='z' AND seq=195; VACUUM");
      await initialization.initializeDatabase(restarted);
      expect(value('turn_text_backfill_cursor', restarted)).toBe(cursor);
      await fill(restarted);
      expect(rows(restarted)).toEqual(expected(restarted));
      expect(value('turn_text_backfilled', restarted)).toBe('9');
      expect(value('turn_text_backfill_cursor', restarted)).toBeUndefined();
    } finally { restarted.close(); }
  });

  it('yields before starting and between batches; trigger edits, deletion and earlier inserts remain exact', async () => {
    legacy(401);
    await initialization.initializeDatabase(sqlite());
    expect(rows()).toEqual([]);
    const filling = fill();
    try {
      expect(rows()).toEqual([]);
      await setImmediate();
      expect(value('turn_text_backfill_cursor')).toBeDefined();
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThan(expected().length);
      sqlite().prepare('UPDATE session_turns SET data=? WHERE session_id=? AND seq=?').run(turn('a', 0, 'changed behind cursor'), 'a', 0);
      sqlite().prepare('UPDATE session_turns SET data=? WHERE session_id=? AND seq=?').run(turn('z', 0, 'changed ahead of cursor'), 'z', 0);
      sqlite().exec("DELETE FROM session_turns WHERE session_id='z' AND seq=198; INSERT INTO sessions(id,project_id,config) VALUES ('0-new','p','{\"version\":\"1\",\"type\":\"acp\"}');");
      insert('0-new', 0, turn('0-new', 0, 'live searchable while backfilling'));
      expect(sqlite().prepare("SELECT count(*) n FROM turn_text WHERE turn_text MATCH 'searchable'").get()).toEqual({ n: 2 });
    } finally { await filling; }
    expect(rows()).toEqual(expected());
    expect(value('turn_text_backfilled')).toBe('9');
  });

  it('invalidates an old completion marker and cursor only when rebuilding structure', async () => {
    legacy();
    sqlite().exec(`INSERT INTO kv(key,value,updated_at) VALUES ('turn_text_backfilled','8',0),('turn_text_backfill_cursor','["z",999]',0);`);
    await initialization.initializeDatabase(sqlite());
    expect(value('turn_text_backfilled')).toBeUndefined();
    expect(value('turn_text_backfill_cursor')).toBeUndefined();
    expect(rows()).toEqual([]);
    await fill();
    const before = rows();
    await initialization.initializeDatabase(sqlite());
    expect(value('turn_text_backfilled')).toBe('9');
    await fill();
    expect(rows()).toEqual(before);
  });
});
