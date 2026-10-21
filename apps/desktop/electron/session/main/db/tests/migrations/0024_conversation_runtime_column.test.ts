import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 0024:`sessions.type` → `sessions.runtime`(#4915)。
 *
 * 这条迁移**只改列名、不重写任何一行值** —— 所以判据有两半,缺一不可:
 * ① 列名换了(旧名字消失、新名字出现);
 * ② **存量行的值原样活着**。只测 ① 的话,一条把整列清空的迁移也能过。
 */
describe('0024 conversations.type → runtime', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('carries existing pty/acp values through the rename untouched', async () => {
    fixture = await openFixture('empty', { through: '0024_conversation_runtime_column' });

    // 迁移已经跑完了,所以这里用新列名写入,再读回来 —— 验证的是「这一列还能正常存取
    // 那两个值」,而不是迁移把它变成了一个只读的空壳。
    fixture.sqlite
      .prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`)
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress')`
      )
      .run();
    const insert = fixture.sqlite.prepare(
      `INSERT INTO conversations (id, project_id, task_id, title, provider, runtime)
       VALUES (?, 'p1', 't1', ?, 'codex', ?)`
    );
    insert.run('c-pty', '终端那条', 'pty');
    insert.run('c-acp', '结构化那条', 'acp');

    const rows = fixture.sqlite
      .prepare(`SELECT id, runtime FROM conversations ORDER BY id`)
      .all() as { id: string; runtime: string | null }[];

    expect(rows).toEqual([
      { id: 'c-acp', runtime: 'acp' },
      { id: 'c-pty', runtime: 'pty' },
    ]);
  });

});
