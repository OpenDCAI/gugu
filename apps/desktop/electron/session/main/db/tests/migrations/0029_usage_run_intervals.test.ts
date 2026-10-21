import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '@main/db/initialize';

/**
 * 0029:用量页的运行区间 + token 日志缓存(#6334)。
 *
 * 要守的是回填:0028 起每条落盘回合带着 startedAt / endedAt,这是本表之前那段历史里唯一的「几点到几点在干活」。
 * 回填必须在一份**停在 0028** 的库上跑才有意义(空库上回填永远是空操作,那样的用例判不出任何东西),
 * 所以这里先按与生产同一套切分规则把 0000–0028 手动套上、插回合,再交给产品的 initializeDatabase 跑 0029。
 */

const drizzleDir = fileURLToPath(new URL('../../../../drizzle/', import.meta.url));
type JournalEntry = { idx: number; when: number; tag: string };

function openAt0028(): { sqlite: Database.Database; close: () => void } {
  const file = path.join(os.tmpdir(), `gugu-0029-${crypto.randomUUID()}.db`);
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)'
  );
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  for (const entry of journal.entries) {
    if (entry.idx > 28) break;
    const sql = fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) sqlite.exec(stmt.trim());
    }
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(crypto.createHash('sha256').update(sql).digest('hex'), entry.when);
  }
  return {
    sqlite,
    close: () => {
      sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    },
  };
}

describe('0029 usage run intervals', () => {
  let handle: ReturnType<typeof openAt0028> | undefined;
  afterEach(() => handle?.close());

  it('停在 0028 的库上:确实还没有这两张表(阳控:否则下面的回填用例测的是空操作)', () => {
    handle = openAt0028();
    const tables = handle.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_run_intervals','usage_token_file_cache')`)
      .all();
    expect(tables).toEqual([]);
  });

  it('从落盘回合回填区间,provider 取自会话;没收口 / 时长 ≤ 0 / 坏 JSON 的回合不回填', async () => {
    handle = openAt0028();
    const { sqlite } = handle;
    sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress');
      INSERT INTO conversations (id, project_id, task_id, title, provider) VALUES ('c1', 'p1', 't1', 'C', 'claude');
      INSERT INTO conversations (id, project_id, task_id, title, provider) VALUES ('c2', 'p1', 't1', 'D', 'codex');
    `);
    const insert = sqlite.prepare(
      `INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES (?, ?, ?, ?, ?)`
    );
    insert.run('c1:0', 'c1', 0, 't0', JSON.stringify({ startedAt: 1_000, endedAt: 61_000, items: [] }));
    insert.run('c1:1', 'c1', 1, 't1', JSON.stringify({ startedAt: 70_000, items: [] })); // 没收口
    insert.run('c1:2', 'c1', 2, 't2', JSON.stringify({ startedAt: 90_000, endedAt: 90_000, items: [] })); // 零长
    insert.run('c1:3', 'c1', 3, 't3', 'not json');
    insert.run('c2:0', 'c2', 0, 't0', JSON.stringify({ startedAt: 5_000, endedAt: 8_000, items: [] }));

    await initializeDatabase(sqlite);

    const rows = sqlite
      .prepare(
        `SELECT session_id, provider, started_at, ended_at, last_seen_at FROM session_run_intervals ORDER BY session_id, started_at`
      )
      .all();
    expect(rows).toEqual([
      { session_id: 'c1', provider: 'claude', started_at: 1_000, ended_at: 61_000, last_seen_at: 61_000 },
      { session_id: 'c2', provider: 'codex', started_at: 5_000, ended_at: 8_000, last_seen_at: 8_000 },
    ]);
  });

  it('没有外键:会话删了,它的区间留着(那天跑过的时长仍是事实)', async () => {
    handle = openAt0028();
    const { sqlite } = handle;
    sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress');
      INSERT INTO conversations (id, project_id, task_id, title, provider) VALUES ('c1', 'p1', 't1', 'C', 'claude');
      INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data)
        VALUES ('c1:0', 'c1', 0, 't0', '{"startedAt":1000,"endedAt":2000}');
    `);
    await initializeDatabase(sqlite);
    sqlite.exec(`DELETE FROM sessions WHERE id = 'c1'`);
    const left = sqlite.prepare('SELECT count(*) AS n FROM session_run_intervals').get() as { n: number };
    expect(left.n).toBe(1);
  });

  it('token 文件缓存表按路径唯一', async () => {
    handle = openAt0028();
    await initializeDatabase(handle.sqlite);
    const insert = handle.sqlite.prepare(
      `INSERT INTO usage_token_file_cache (path, size, mtime_ms, provider, provider_session_id, data) VALUES ('/a', 1, 1, 'claude', 's', '{}')`
    );
    insert.run();
    expect(() => insert.run()).toThrow();
  });
});
