import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '@main/db/initialize';

/**
 * 0032:task → session。要守的是**守恒**:会话一条不少、消息与回合不被重建连带删掉、终端与附件都有归属、
 * 视图状态跟到代表会话上、库里不再有 task。必须在一份**停在 0031、带着数据**的库上跑才有意义。
 */

const drizzleDir = fileURLToPath(new URL('../../../../drizzle/', import.meta.url));
type JournalEntry = { idx: number; when: number; tag: string };

function openAt0031(): { sqlite: Database.Database; close: () => void } {
  const file = path.join(os.tmpdir(), `gugu-0032-${crypto.randomUUID()}.db`);
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)'
  );
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  for (const entry of journal.entries) {
    if (entry.idx > 31) break;
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

// v0.2.51 的形状:一个 #5665 之前挂两条会话的 task(首条会话不是最近的那条)、一次自动化运行、
// 一个 standalone、一个名下没有会话的 task;外加消息、回合、终端、附件和三类视图状态。
const SEED = `
INSERT INTO projects (id, name, path) VALUES ('P', 'p', '/p');
INSERT INTO automations (id, name, created_at, updated_at) VALUES ('A', 'a', 0, 0);
INSERT INTO automation_runs (id, automation_id, status, trigger_kind, task_created_at, generated_task_name)
  VALUES ('R', 'A', 'done', 'cron', 7, 'nightly');
INSERT INTO tasks (id, project_id, name, status, workspace_id, linked_issue, type, automation_run_id, archived_at) VALUES
  ('T-multi', 'P', 'multi', 'todo', 'W-shared', '{"version":"1","provider":"github","identifier":"#1"}', 'task', NULL, '2026-09-20'),
  ('T-auto', 'P', 'auto', 'todo', 'W-shared', NULL, 'automation-run', 'R', NULL),
  ('T-solo', 'P', 'solo', 'todo', 'W-solo', NULL, 'standalone', 'R-deleted', NULL),
  ('T-empty', 'P', 'empty', 'todo', NULL, NULL, 'task', NULL, NULL);
INSERT INTO conversations (id, project_id, task_id, title, is_initial_conversation, last_interacted_at, is_pinned, archived_at) VALUES
  ('C-recent', 'P', 'T-multi', 'recent', 0, '2026-09-19', 1, '2026-09-20'),
  ('C-first', 'P', 'T-multi', 'first', 1, '2026-09-01', 0, '2026-09-20'),
  ('C-auto', 'P', 'T-auto', 'auto', NULL, NULL, 0, NULL),
  ('C-solo', 'P', 'T-solo', 'solo', NULL, NULL, 0, NULL);
INSERT INTO messages (id, conversation_id, content, sender) VALUES ('M1', 'C-recent', 'hi', 'user'), ('M2', 'C-solo', 'yo', 'user');
INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES ('C-first:0', 'C-first', 0, 't', '[]');
INSERT INTO terminals (id, project_id, task_id, name) VALUES ('X-multi', 'P', 'T-multi', 'sh'), ('X-empty', 'P', 'T-empty', 'sh');
INSERT INTO task_attachments (id, task_id, name, size, stored_path, origin) VALUES
  ('F-multi', 'T-multi', 'a.txt', 1, '/ud/task-attachments/T-multi/a.txt', 'copy'),
  ('F-empty', 'T-empty', 'b.txt', 1, '/ud/task-attachments/T-empty/b.txt', 'copy');
INSERT INTO kv (key, value) VALUES
  ('view-state:task:T-multi', '{"sidebarTab":"files"}'),
  ('view-state:task:T-multi:tabs', '{"groups":[{"groupId":"g","tabManager":{"tabs":[{"kind":"review","tabId":"r","taskId":"T-multi","isPreview":false},{"kind":"conversation","tabId":"c","conversationId":"C-recent","isPreview":false}],"activeTabId":"c"}}],"activeGroupId":"g","paneSizes":[100]}'),
  ('view-state:task:T-empty', '{}'),
  ('view-state:navigation', '{"currentViewId":"task","viewParams":{"task":{"projectId":"P","taskId":"T-solo"},"settings":{"tab":"x"}}}'),
  ('view-state:sidebar', '{"projectOrder":["P"],"taskOrderByProject":{"P":["T-solo","T-multi","T-empty"]},"tasksCollapsed":false}'),
  ('taskpage-platform-model:C-solo', '{"modelId":"m"}');
`;

const rows = (db: Database.Database, sql: string) => db.prepare(sql).all();
const kvValue = (db: Database.Database, key: string) =>
  JSON.parse((db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string }).value);

describe('0032 task → session', () => {
  let handle: ReturnType<typeof openAt0031> | undefined;
  afterEach(() => handle?.close());

  it('阳控:停在 0031 的库上 task 还在,会话还挂在 task 下', () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    expect(rows(handle.sqlite, `SELECT name FROM sqlite_master WHERE name = 'tasks'`)).toHaveLength(1);
    expect(rows(handle.sqlite, `SELECT task_id FROM conversations WHERE id = 'C-first'`)).toEqual([{ task_id: 'T-multi' }]);
  });

  it('会话守恒,并带上 task 的工作区、关联 issue、自动化运行', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(
      rows(handle.sqlite, 'SELECT id, workspace_id, linked_issue, automation_run_id, is_pinned, archived_at FROM sessions ORDER BY id')
    ).toEqual([
      { id: 'C-auto', workspace_id: 'W-shared', linked_issue: null, automation_run_id: 'R', is_pinned: 0, archived_at: null },
      { id: 'C-first', workspace_id: 'W-shared', linked_issue: '{"version":"1","provider":"github","identifier":"#1"}', automation_run_id: null, is_pinned: 0, archived_at: '2026-09-20' },
      { id: 'C-recent', workspace_id: 'W-shared', linked_issue: '{"version":"1","provider":"github","identifier":"#1"}', automation_run_id: null, is_pinned: 1, archived_at: '2026-09-20' },
      // 指向已删运行的值没有外键可言,迁移后置空,而不是留一条违例
      { id: 'C-solo', workspace_id: 'W-solo', linked_issue: null, automation_run_id: null, is_pinned: 0, archived_at: null },
    ]);
  });

  it('重建会话表不连带删掉消息和回合', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, 'SELECT id FROM messages ORDER BY id')).toEqual([{ id: 'M1' }, { id: 'M2' }]);
    expect(rows(handle.sqlite, 'SELECT id FROM session_turns')).toEqual([{ id: 'C-first:0' }]);
    expect(handle.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('终端和附件归给代表会话(首条会话优先于最近交互);没有会话的 task 的随它消失', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, 'SELECT id, session_id FROM terminals')).toEqual([{ id: 'X-multi', session_id: 'C-first' }]);
    expect(rows(handle.sqlite, 'SELECT id, session_id, stored_path FROM session_attachments')).toEqual([
      { id: 'F-multi', session_id: 'C-first', stored_path: '/ud/task-attachments/T-multi/a.txt' },
    ]);
  });

  it('视图状态:按 task 的键归给代表会话,上次停的视图与侧栏手排顺序换成会话 id', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, `SELECT key FROM kv WHERE key LIKE 'view-state:%' ORDER BY key`)).toEqual([
      { key: 'view-state:navigation' },
      { key: 'view-state:session:C-first' },
      { key: 'view-state:session:C-first:tabs' },
      { key: 'view-state:sidebar' },
    ]);
    expect(kvValue(handle.sqlite, 'view-state:session:C-first')).toEqual({ sidebarTab: 'files' });
    expect(kvValue(handle.sqlite, 'view-state:session:C-first:tabs').groups[0].tabManager.tabs[0]).toEqual({
      kind: 'review', tabId: 'r', sessionId: 'C-first', isPreview: false,
    });
    expect(kvValue(handle.sqlite, 'view-state:navigation')).toEqual({
      currentViewId: 'session',
      viewParams: { session: { projectId: 'P', sessionId: 'C-solo' }, settings: { tab: 'x' } },
    });
    expect(kvValue(handle.sqlite, 'view-state:sidebar')).toEqual({
      projectOrder: ['P'],
      sessionOrderByProject: { P: ['C-solo', 'C-first', 'C-recent'] },
      tasksCollapsed: false,
    });
    // 键本来就是会话 id,0032 不动它;前缀是 0033 换的(initializeDatabase 跑完整条链)
    expect(kvValue(handle.sqlite, 'sessionpage-platform-model:C-solo')).toEqual({ modelId: 'm' });
  });

  it('自动化运行的列改名,值不变', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, 'SELECT session_created_at, generated_session_name FROM automation_runs')).toEqual([
      { session_created_at: 7, generated_session_name: 'nightly' },
    ]);
  });

  it('task 没了;交接表给段 2 留着每个 task 的类型和会话', async () => {
    handle = openAt0031();
    handle.sqlite.exec(SEED);
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, `SELECT name FROM sqlite_master WHERE name IN ('tasks', 'task_attachments')`)).toEqual([]);
    expect(
      rows(handle.sqlite, 'SELECT task_id, project_id, task_type, session_id, is_scope_owner FROM legacy_task_map ORDER BY task_id, session_id')
    ).toEqual([
      { task_id: 'T-auto', project_id: 'P', task_type: 'automation-run', session_id: 'C-auto', is_scope_owner: 1 },
      { task_id: 'T-empty', project_id: 'P', task_type: 'task', session_id: null, is_scope_owner: 0 },
      { task_id: 'T-multi', project_id: 'P', task_type: 'task', session_id: 'C-first', is_scope_owner: 1 },
      { task_id: 'T-multi', project_id: 'P', task_type: 'task', session_id: 'C-recent', is_scope_owner: 0 },
      { task_id: 'T-solo', project_id: 'P', task_type: 'standalone', session_id: 'C-solo', is_scope_owner: 1 },
    ]);
  });

  it('空库:跑得通,交接表为空', async () => {
    handle = openAt0031();
    await initializeDatabase(handle.sqlite);
    expect(rows(handle.sqlite, 'SELECT count(*) AS n FROM legacy_task_map')).toEqual([{ n: 0 }]);
    expect(rows(handle.sqlite, 'SELECT count(*) AS n FROM sessions')).toEqual([{ n: 0 }]);
  });
});
