import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openFixture } from '@tooling/utils/db';
import { parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 0031:附属态一列 + 基础态的词随词表换算一次(spec agent-status-vocabulary)。
 *
 * 判据直接执行迁移文件里那两条换算语句(❌ 在测试里重写一遍 SQL)。`openFixture` 已经把全部迁移跑完,
 * 所以先把行写回 0031 之前的词,再让那两条语句跑一遍。
 */
const [, ...TRANSLATIONS] = readFileSync(
  fileURLToPath(new URL('../../../../drizzle/0031_conversation_agent_status_detail.sql', import.meta.url)),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim());

describe('0031 conversations.agent_status_detail', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('旧词按当时的意思换成新词,其它词与空值原样', async () => {
    fixture = await openFixture('empty', { through: '0031_conversation_agent_status_detail' });
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite.prepare(`INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress')`).run();
    const before: Record<string, string | null> = {
      approval: 'needs_approval',
      awaiting: 'awaiting-input',
      completed: 'completed',
      working: 'working',
      idle: 'idle',
      error: 'error',
      none: null,
    };
    for (const [id, status] of Object.entries(before)) {
      fixture.sqlite
        .prepare(`INSERT INTO conversations (id, project_id, task_id, title, agent_status) VALUES (?, 'p1', 't1', 'C', ?)`)
        .run(id, status);
    }
    expect(TRANSLATIONS).toHaveLength(2);
    for (const statement of TRANSLATIONS) fixture.sqlite.exec(statement);

    const after = Object.fromEntries(
      (
        fixture.sqlite.prepare(`SELECT id, agent_status FROM conversations ORDER BY id`).all() as {
          id: string;
          agent_status: string | null;
        }[]
      ).map((r) => [r.id, r.agent_status]),
    );
    expect(after).toEqual({
      approval: 'needs_user',
      awaiting: 'needs_user',
      completed: 'idle',
      working: 'working',
      idle: 'idle',
      error: 'error',
      none: null,
    });
    // 迁移与读盘的换算是同一张表。
    for (const [id, status] of Object.entries(before)) expect(after[id]).toBe(parseAgentStatus(status));
  });

  it('附属态一列存在,新行默认没有附属态', async () => {
    fixture = await openFixture('empty', { through: '0031_conversation_agent_status_detail' });
    const columns = fixture.sqlite.prepare(`PRAGMA table_info(conversations)`).all() as { name: string; dflt_value: unknown }[];
    expect(columns.find((c) => c.name === 'agent_status_detail')).toMatchObject({ dflt_value: null });
  });
});
