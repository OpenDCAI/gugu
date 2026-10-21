import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 0025:输入框附件的记录表(#5269)。
 *
 * 这张表的存在理由是「字节存一份在我们自己的地盘」——从前它们落在 `$TMPDIR`,
 * 退出即清、24 小时扫,而消息里的 mention 长期指着它。**记录挂在任务上**,
 * 任务删了附件跟着删,清理就不必另外发明保留策略。
 */
describe('0025 task_attachments', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  function seedTask(): void {
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(`INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress')`)
      .run();
  }

  it('建出了这张表,并且记得住 copy / reference 两种来源', async () => {
    fixture = await openFixture('empty', { through: '0025_task_attachments' });
    seedTask();

    const insert = fixture.sqlite.prepare(
      `INSERT INTO task_attachments (id, task_id, name, mime_type, size, stored_path, origin)
       VALUES (?, 't1', ?, ?, ?, ?, ?)`
    );
    insert.run('a1', 'code-card.png', 'image/png', 39054, '/u/task-attachments/t1/a1-code-card.png', 'copy');
    insert.run('a2', 'notes.md', 'text/markdown', 12, '/Users/me/notes.md', 'reference');

    const rows = fixture.sqlite
      .prepare(`SELECT id, name, origin, stored_path FROM task_attachments ORDER BY id`)
      .all() as { id: string; name: string; origin: string; stored_path: string }[];

    expect(rows).toEqual([
      {
        id: 'a1',
        name: 'code-card.png',
        origin: 'copy',
        stored_path: '/u/task-attachments/t1/a1-code-card.png',
      },
      { id: 'a2', name: 'notes.md', origin: 'reference', stored_path: '/Users/me/notes.md' },
    ]);
  });

  /**
   * ⚠️ 这条只管**行**。盘上那些字节不归 cascade 管,清它们是 `deleteTask` 里显式的一步,
   * 判据在 `deleteTask.test.ts`(顺序:清文件必须早于删行)。两条缺一不可 ——
   * 只有这一条的话,「任务删了、文件永远留着」照样绿。
   */
  it('任务删掉时附件行跟着走', async () => {
    fixture = await openFixture('empty', { through: '0025_task_attachments' });
    seedTask();
    fixture.sqlite
      .prepare(
        `INSERT INTO task_attachments (id, task_id, name, size, stored_path, origin)
         VALUES ('a1', 't1', 'x.png', 1, '/u/a1.png', 'copy')`
      )
      .run();

    fixture.sqlite.prepare(`DELETE FROM tasks WHERE id = 't1'`).run();

    const left = fixture.sqlite
      .prepare(`SELECT count(*) AS n FROM task_attachments`)
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('❌ 不许挂在一个不存在的任务下', async () => {
    // 阳控:外键没生效的话这一行会插进去,上面那条 cascade 也就成了空话。
    fixture = await openFixture('empty', { through: '0025_task_attachments' });

    expect(() =>
      fixture.sqlite
        .prepare(
          `INSERT INTO task_attachments (id, task_id, name, size, stored_path, origin)
           VALUES ('a1', 'no-such-task', 'x.png', 1, '/u/a1.png', 'copy')`
        )
        .run()
    ).toThrow();
  });
});
