import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

/**
 * 0033:名字层。表、列、索引换成 session 的词,harness 自己的会话 id 叫 provider_session_id;
 * 行与值的意思一个不动。种子按 0032 之后的形状写,再只跑 0033 这一个文件(❌ 在测试里重写一遍 SQL)。
 */
const MIGRATION = bundledMigrations().find((migration) => migration.tag === '0033_session_naming');

describe('0033 session naming', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  async function seeded() {
    fixture = await openFixture('empty', { through: '0032_task_to_session' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO workspaces (id, type, path) VALUES ('w1', 'local', '/repo');
      INSERT INTO conversations (id, project_id, workspace_id, title, provider, session_id, parent_conversation_id, spawned_by_conversation_id)
        VALUES ('parent', 'p1', 'w1', 'Parent', 'claude', 'claude-native-1', NULL, NULL),
               ('child', 'p1', 'w1', 'Child', 'codex', 'codex-thread-2', 'parent', 'parent');
      INSERT INTO messages (id, conversation_id, content, sender) VALUES ('m1', 'child', 'hi', 'user');
      INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES ('t1', 'child', 1, 'turn-1', '{}');
      INSERT INTO conversation_run_intervals (conversation_id, provider, started_at, last_seen_at) VALUES ('child', 'codex', 1, 1);
      INSERT INTO conversation_model_sources (conversation_id, source, started_at) VALUES ('child', 'gugu', 1);
      INSERT INTO usage_token_file_cache (path, provider, session_id, mtime_ms, size, data) VALUES ('/x.jsonl', 'claude', 'claude-native-1', 1, 1, '{}');
      INSERT INTO terminals (id, project_id, session_id, name) VALUES ('term1', 'p1', 'child', 'T');
    `);
    return sql;
  }

  it('表、列、索引换成 session 的词,值原样;外键跟着指向 sessions', async () => {
    const sql = await seeded();
    expect(MIGRATION).toBeDefined();
    applyMigrations(sql, [MIGRATION!]);

    const tables = (sql.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['sessions', 'session_turns', 'session_run_intervals', 'session_model_sources']));
    expect(tables).not.toEqual(expect.arrayContaining(['conversations']));
    expect(tables.filter((name) => name.startsWith('conversation'))).toEqual([]);

    expect(sql.prepare(`SELECT id, provider_session_id, parent_session_id, spawned_by_session_id FROM sessions ORDER BY id`).all()).toEqual([
      { id: 'child', provider_session_id: 'codex-thread-2', parent_session_id: 'parent', spawned_by_session_id: 'parent' },
      { id: 'parent', provider_session_id: 'claude-native-1', parent_session_id: null, spawned_by_session_id: null },
    ]);
    expect(sql.prepare(`SELECT session_id FROM messages`).get()).toEqual({ session_id: 'child' });
    expect(sql.prepare(`SELECT session_id FROM session_turns`).get()).toEqual({ session_id: 'child' });
    expect(sql.prepare(`SELECT session_id FROM session_run_intervals`).get()).toEqual({ session_id: 'child' });
    expect(sql.prepare(`SELECT session_id FROM session_model_sources`).get()).toEqual({ session_id: 'child' });
    expect(sql.prepare(`SELECT provider_session_id FROM usage_token_file_cache`).get()).toEqual({ provider_session_id: 'claude-native-1' });

    const indexes = (sql.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`).all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_sessions_workspace_id',
      'idx_sessions_parent_session_id',
      'idx_sessions_spawned_by_extension_id',
      'idx_sessions_spawned_by_session_id',
      'idx_messages_session_id',
      'idx_session_turns_session_seq',
      'idx_session_run_intervals_started_at',
      'idx_session_run_intervals_session_ended',
      'idx_session_model_sources_session_started',
    ]));
    expect(indexes.filter((name) => name.includes('conversation'))).toEqual([]);

    // 外键子句跟着表名走:删一条会话,挂在它上面的行照旧级联
    for (const table of ['messages', 'session_turns', 'terminals']) {
      const targets = (sql.prepare(`SELECT "table" FROM pragma_foreign_key_list(?)`).all(table) as { table: string }[]).map((r) => r.table);
      expect(targets).toContain('sessions');
    }
    expect(sql.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    sql.pragma('foreign_keys = ON');
    sql.prepare(`DELETE FROM sessions WHERE id = 'child'`).run();
    expect(sql.prepare(`SELECT count(*) AS n FROM messages`).get()).toEqual({ n: 0 });
    expect(sql.prepare(`SELECT count(*) AS n FROM terminals`).get()).toEqual({ n: 0 });
  });

  it('自动化:两份配置换名;运行的三步状态与错误里的 step 换成新词,别的值不动', async () => {
    const sql = await seeded();
    sql.exec(`
      INSERT INTO automations (id, name, project_id, conversation_config, task_config, trigger_config, created_at, updated_at)
        VALUES ('a1', 'A', 'p1', '{"prompt":"go"}', '{"version":"1"}', '{}', 1, 1);
      INSERT INTO automation_runs (id, automation_id, status, trigger_kind, conversation_config_snapshot, task_config_snapshot, error)
        VALUES ('r1', 'a1', 'creating_task', 'cron', '{"prompt":"go"}', '{"version":"1"}', NULL),
               ('r2', 'a1', 'launching_task', 'cron', '{}', NULL, NULL),
               ('r3', 'a1', 'creating_conversation', 'cron', '{}', NULL, NULL),
               ('r4', 'a1', 'failed', 'cron', '{}', NULL, '{"step":"launch_task","code":"interrupted_by_restart"}'),
               ('r5', 'a1', 'failed', 'cron', '{}', NULL, '{"step":"queue","code":"no_project"}'),
               ('r6', 'a1', 'done', 'manual', '{}', NULL, NULL);
    `);
    applyMigrations(sql, [MIGRATION!]);

    expect(sql.prepare(`SELECT agent_config, session_config FROM automations`).get()).toEqual({
      agent_config: '{"prompt":"go"}',
      session_config: '{"version":"1"}',
    });
    const runs = sql.prepare(`SELECT id, status, json_extract(error, '$.step') AS step, agent_config_snapshot, session_config_snapshot FROM automation_runs ORDER BY id`).all();
    expect(runs).toEqual([
      { id: 'r1', status: 'creating_session', step: null, agent_config_snapshot: '{"prompt":"go"}', session_config_snapshot: '{"version":"1"}' },
      { id: 'r2', status: 'launching_session', step: null, agent_config_snapshot: '{}', session_config_snapshot: null },
      { id: 'r3', status: 'starting_agent', step: null, agent_config_snapshot: '{}', session_config_snapshot: null },
      { id: 'r4', status: 'failed', step: 'launch_session', agent_config_snapshot: '{}', session_config_snapshot: null },
      { id: 'r5', status: 'failed', step: 'queue', agent_config_snapshot: '{}', session_config_snapshot: null },
      { id: 'r6', status: 'done', step: null, agent_config_snapshot: '{}', session_config_snapshot: null },
    ]);
  });

  it('存着的键:设置行 tasks → sessions,平台模型选择换前缀;别的行与值不动', async () => {
    const sql = await seeded();
    sql.exec(`
      INSERT INTO app_settings (key, value) VALUES ('tasks', '{"autoGenerateName":false}'), ('keyboard', '{"newTask":"Mod+N"}');
      INSERT INTO kv (key, value) VALUES
        ('taskpage-platform-model:child', '{"modelId":"m"}'),
        ('view-state:sidebar', '{"tasksCollapsed":true}'),
        ('x-taskpage-platform-model:child', '{}');
    `);
    applyMigrations(sql, [MIGRATION!]);

    expect(sql.prepare(`SELECT key, value FROM app_settings ORDER BY key`).all()).toEqual([
      { key: 'keyboard', value: '{"newTask":"Mod+N"}' },
      { key: 'sessions', value: '{"autoGenerateName":false}' },
    ]);
    expect(sql.prepare(`SELECT key, value FROM kv ORDER BY key`).all()).toEqual([
      { key: 'sessionpage-platform-model:child', value: '{"modelId":"m"}' },
      { key: 'view-state:sidebar', value: '{"tasksCollapsed":true}' },
      { key: 'x-taskpage-platform-model:child', value: '{}' },
    ]);
  });
});
