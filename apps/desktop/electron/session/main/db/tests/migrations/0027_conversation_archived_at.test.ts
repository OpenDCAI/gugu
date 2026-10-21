import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 0027:归档的归属键从 task 收到**会话自己**(#5413),并回填历史。
 *
 * 回填是这次迁移的一半。在 0027 之前,一条会话可不可见由它所属 task 的 `archived_at` 回答;之后
 * `getSessions()` 只问 `sessions.archived_at`。⇒ **不回填就等于把存量已归档任务的会话全部
 * 放回会话列表**,而那一格看起来跟「归档坏了」一模一样。
 *
 * 判据直接执行迁移文件里那条回填语句(❌ 在测试里重写一遍 SQL —— 那测的是测试自己的副本)。
 * `openFixture` 已经把全部迁移跑完,所以这里先把已归档任务的会话手工退回「没有章」的状态,
 * 复原 0027 之前的形状,再让那条语句跑一遍。
 */
const BACKFILL = readFileSync(
  fileURLToPath(new URL('../../../../drizzle/0027_conversation_archived_at.sql', import.meta.url)),
  'utf8'
)
  .split('--> statement-breakpoint')[1]!
  .trim();

describe('0027 conversations.archived_at', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  async function seed(): Promise<void> {
    fixture = await openFixture('empty', { through: '0027_conversation_archived_at' });
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    // 一项已归档的 task(容器带着章)+ 一项活着的 task。
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status, archived_at)
         VALUES ('t-archived', 'p1', 'Archived', 'in_progress', '2026-09-01 10:00:00')`
      )
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status) VALUES ('t-live', 'p1', 'Live', 'in_progress')`
      )
      .run();
    for (const [id, taskId] of [
      ['c-arch-1', 't-archived'],
      ['c-arch-2', 't-archived'],
      ['c-live', 't-live'],
    ]) {
      fixture.sqlite
        .prepare(
          `INSERT INTO conversations (id, project_id, task_id, title) VALUES (?, 'p1', ?, 'C')`
        )
        .run(id, taskId);
    }
    // 0027 之前的形状:会话行上什么都没有。
    fixture.sqlite.prepare(`UPDATE conversations SET archived_at = NULL`).run();
  }

  const stamps = () =>
    Object.fromEntries(
      (
        fixture.sqlite
          .prepare(`SELECT id, archived_at FROM conversations ORDER BY id`)
          .all() as { id: string; archived_at: string | null }[]
      ).map((r) => [r.id, r.archived_at])
    );

  it('已归档任务的会话补上容器那个章,活着的任务一个都不碰', async () => {
    await seed();
    // 阳控:回填之前三条都没有章 —— 否则「回填生效了」与「它们本来就有章」同形。
    expect(stamps()).toEqual({ 'c-arch-1': null, 'c-arch-2': null, 'c-live': null });

    fixture.sqlite.exec(BACKFILL);

    expect(stamps()).toEqual({
      'c-arch-1': '2026-09-01 10:00:00',
      'c-arch-2': '2026-09-01 10:00:00',
      'c-live': null,
    });
  });

});
