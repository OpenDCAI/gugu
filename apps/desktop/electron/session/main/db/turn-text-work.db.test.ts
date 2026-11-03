import Database from 'better-sqlite3';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { backfillTurnText, initializeDatabase } from './initialize';

let fixture: FixtureDb;
let nativeJson: Database.Database;
const sqlite = () => fixture.sqlite;
const rows = () => sqlite().prepare('SELECT seq, item_id, role, text FROM turn_text_rows ORDER BY seq, item_id').all();

function turn(seq: number, messages = 12, payload = 'unsearchable payload '.repeat(100)): string {
  const id = `a:turn:${seq}`;
  return JSON.stringify({ id, referenceId: `source:${seq}`, items: [
    { kind: 'tool-call', id: `${id}:tool:0`, output: payload },
    ...Array.from({ length: messages }, (_, i) => ({
      kind: 'message', id: `${id}:message:${i}`, role: 'assistant', text: `unique text ${seq} ${i}`,
    })),
  ] });
}

function insert(seq: number, data: string): void {
  sqlite().prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES(?,?,?,?,?)')
    .run(`a:${seq}`, 'a', seq, `turn-${seq}`, data);
}

function resetBackfill(): void {
  sqlite().exec("DELETE FROM turn_text_rows; DELETE FROM kv WHERE key IN ('turn_text_backfilled','turn_text_backfill_cursor')");
}

async function intervalEnds(): Promise<number[]> {
  const ends: number[] = [];
  sqlite().function('record_backfill_cursor', (value: string) => {
    ends.push((JSON.parse(value) as [string, number])[1]);
    return null;
  });
  sqlite().exec(`CREATE TRIGGER record_cursor AFTER INSERT ON kv WHEN NEW.key='turn_text_backfill_cursor'
    BEGIN SELECT record_backfill_cursor(NEW.value); END`);
  let tick = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => tick += 50);
  await backfillTurnText(sqlite());
  return ends;
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  nativeJson = new Database(':memory:');
  sqlite().exec(`INSERT INTO projects(id,name,path) VALUES('p','Project','/repo');
    INSERT INTO sessions(id,project_id,config) VALUES('a','p','{"version":"1","type":"acp"}');`);
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
  nativeJson.close();
});

describe('turn-text extraction work and identity', () => {
  it.each(['insert', 'update', 'backfill'] as const)('%s reads whole-turn identity once for many messages', async (path) => {
    const data = turn(0);
    if (path === 'update') insert(0, turn(0, 1));
    if (path === 'backfill') { insert(0, data); resetBackfill(); }
    const extract = nativeJson.prepare('SELECT json_extract(?, ?) AS value');
    let reads = 0;
    // Count actual full-blob scalar evaluations; delegate values to SQLite's native implementation.
    sqlite().function('json_extract', { deterministic: true }, (json: unknown, jsonPath: unknown) => {
      if (json === data && (jsonPath === '$.id' || jsonPath === '$.referenceId')) reads++;
      return (extract.get(json, jsonPath) as { value: string | number | bigint | Buffer | null }).value;
    });
    if (path === 'insert') insert(0, data);
    else if (path === 'update') sqlite().prepare("UPDATE session_turns SET data=? WHERE session_id='a' AND seq=0").run(data);
    else await backfillTurnText(sqlite());
    expect(rows()).toEqual(Array.from({ length: 12 }, (_, i) => ({
      seq: 0, item_id: `source:0:message:${i}`, role: 'assistant', text: `unique text 0 ${i}`,
    })).sort((a, b) => a.item_id.localeCompare(b.item_id)));
    expect(reads).toBe(2);
    expect(() => sqlite().exec("INSERT INTO turn_text(turn_text,rank) VALUES('integrity-check',1)")).not.toThrow();
  });

  it.each(['insert', 'update', 'backfill'] as const)('%s ignores invalid JSON without leaving text rows', async (path) => {
    if (path === 'update') insert(0, turn(0));
    if (path === 'backfill') { insert(0, 'invalid JSON'); resetBackfill(); }
    if (path === 'insert') expect(() => insert(0, 'invalid JSON')).not.toThrow();
    else if (path === 'update') expect(() => sqlite().prepare("UPDATE session_turns SET data='invalid JSON' WHERE session_id='a'").run()).not.toThrow();
    else await expect(backfillTurnText(sqlite())).resolves.toBeUndefined();
    expect(rows()).toEqual([]);
  });

  for (const path of ['insert', 'update', 'backfill'] as const) {
    it.each([
      ['missing referenceId', 'a:turn:0', undefined, 'a:turn:0'],
      ['numeric id', 42, 'source:numeric', 'source:numeric'],
      ['numeric referenceId', 'a:turn:0', 42, 'a:turn:0'],
    ] as const)(`${path} preserves %s identity through native JSON values`, async (_case, id, referenceId, expectedId) => {
      const data = JSON.stringify({ id, referenceId, items: [
        { kind: 'message', id: `${id}:message:0`, role: 'user', text: 'first unique' },
        { kind: 'message', id: `${id}:message:1`, role: 'assistant', text: 'second unique' },
      ] });
      if (path === 'update') insert(0, turn(0));
      if (path === 'backfill') { insert(0, data); resetBackfill(); }
      if (path === 'insert') insert(0, data);
      else if (path === 'update') sqlite().prepare("UPDATE session_turns SET data=? WHERE session_id='a'").run(data);
      else await backfillTurnText(sqlite());
      expect(rows()).toEqual([
        { seq: 0, item_id: `${expectedId}:message:0`, role: 'user', text: 'first unique' },
        { seq: 0, item_id: `${expectedId}:message:1`, role: 'assistant', text: 'second unique' },
      ]);
    });
  }

  it('rebuilds existing v8 triggers and resets their completed backfill before upgrading to v9', async () => {
    insert(0, turn(0));
    sqlite().exec(`UPDATE kv SET value='8' WHERE key='fts_version';
      INSERT OR REPLACE INTO kv(key,value,updated_at) VALUES('turn_text_backfilled','8',0);
      DROP TRIGGER session_turns_text_insert;
      CREATE TRIGGER session_turns_text_insert AFTER INSERT ON session_turns BEGIN
        SELECT RAISE(ABORT,'old v8 trigger');
      END;`);
    await initializeDatabase(sqlite());
    expect(sqlite().prepare("SELECT value FROM kv WHERE key='fts_version'").get()).toEqual({ value: '9' });
    expect(sqlite().prepare("SELECT value FROM kv WHERE key='turn_text_backfilled'").get()).toBeUndefined();
    expect(rows()).toEqual([]);
    expect(() => insert(1, turn(1))).not.toThrow();
    await backfillTurnText(sqlite());
    expect(rows()).toHaveLength(24);
  });

  it('commits and yields when row work reaches the transaction budget rather than a fixed turn count', async () => {
    for (let seq = 0; seq < 130; seq++) insert(seq, turn(seq, 2));
    resetBackfill();
    let work = 0;
    sqlite().function('record_row_work', () => { work++; return null; });
    sqlite().exec('CREATE TRIGGER measure_row_work AFTER INSERT ON turn_text_rows BEGIN SELECT record_row_work(); END');
    // One synthetic millisecond per indexed row, independent of machine load or wall-clock speed.
    vi.spyOn(performance, 'now').mockImplementation(() => work);
    const filling = backfillTurnText(sqlite());
    try {
      await setImmediate();
      expect(work).toBeGreaterThanOrEqual(50);
      // At most one 64-turn interval (two messages per turn) can exceed the budget.
      expect(work).toBeLessThanOrEqual(50 + 64 * 2);
      expect(rows().length).toBeLessThan(260);
      expect(sqlite().prepare("SELECT value FROM kv WHERE key='turn_text_backfill_cursor'").get()).toBeDefined();
    } finally { await filling; }
    expect(rows()).toHaveLength(260);
  });

  it('groups small turns into intervals of at most 64 and resumes the final partial interval', async () => {
    for (let seq = 0; seq < 130; seq++) insert(seq, turn(seq, 2, ''));
    resetBackfill();
    expect(await intervalEnds()).toEqual([63, 127, 129]);
    expect(rows()).toHaveLength(260);
  });

  it('keeps a single oversized turn whole in its own interval', async () => {
    insert(0, turn(0, 2, 'x'.repeat(1024 * 1024)));
    insert(1, turn(1, 2, ''));
    insert(2, turn(2, 2, ''));
    resetBackfill();
    expect(await intervalEnds()).toEqual([0, 2]);
    expect(rows()).toHaveLength(6);
  });

  it('includes the turn that first crosses one MiB of stored UTF-8 bytes', async () => {
    const first = turn(0, 2, '界'.repeat(200_000));
    const second = turn(1, 2, '界'.repeat(200_000));
    expect(first.length + second.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(first) + Buffer.byteLength(second)).toBeGreaterThan(1024 * 1024);
    insert(0, first);
    insert(1, second);
    insert(2, turn(2, 2, ''));
    insert(3, turn(3, 2, ''));
    resetBackfill();
    expect(await intervalEnds()).toEqual([1, 3]);
    expect(rows()).toHaveLength(8);
  });

  it('uses the last available turn when fewer than 64 remain below one MiB', async () => {
    for (let seq = 0; seq < 7; seq++) insert(seq, turn(seq, 2, ''));
    resetBackfill();
    expect(await intervalEnds()).toEqual([6]);
    expect(rows()).toHaveLength(14);
  });
});
