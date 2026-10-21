import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

/**
 * 0035:工作区多两格 —— 挂在哪个项目下(带外键,项目删了放回无主)、什么时候挂上的。老行(根目录、worktree)
 * 一行不动:两格都是 null。种子按 0034 之后的形状写,再只跑 0035 这一个文件(❌ 在测试里重写一遍 SQL)。
 */
const MIGRATION = bundledMigrations().find((migration) => migration.tag === '0036_project_folders');

describe('0035 project folders', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  async function seeded() {
    fixture = await openFixture('empty', { through: '0035_permission_mode_only' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root', 'project-root', 'local', 'local', '/repo', 'k-root');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-old', 'worktree', 'local', 'local', '/repo-wt', 'k-wt');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p1', 'P', '/repo', 'ws-root');
    `);
    return sql;
  }

  it('老行原样,两格为空;新格可写;项目删了挂着的文件夹放回无主、行还在', async () => {
    const sql = await seeded();
    expect(MIGRATION).toBeDefined();
    applyMigrations(sql, [MIGRATION!]);

    expect(sql.prepare(`SELECT id, kind, path, project_id, attached_at FROM workspaces ORDER BY id`).all()).toEqual([
      { id: 'ws-old', kind: 'worktree', path: '/repo-wt', project_id: null, attached_at: null },
      { id: 'ws-root', kind: 'project-root', path: '/repo', project_id: null, attached_at: null },
    ]);
    expect(sql.prepare(`SELECT repository_workspace_id FROM projects WHERE id = 'p1'`).get()).toEqual({
      repository_workspace_id: 'ws-root',
    });

    const indexes = (
      sql.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspaces'`).all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toContain('idx_workspaces_project_id');

    const foreignKeys = sql.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('workspaces')`).all();
    expect(foreignKeys).toContainEqual({ table: 'projects', from: 'project_id', on_delete: 'SET NULL' });

    sql.pragma('foreign_keys = ON');
    sql.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key, project_id, attached_at)
        VALUES ('ws-attached', 'path', 'local', 'local', '/related', 'k-related', 'p1', '2026-10-16T08:30:00.000Z');
    `);
    expect(sql.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    sql.prepare(`DELETE FROM projects WHERE id = 'p1'`).run();
    expect(sql.prepare(`SELECT id, project_id FROM workspaces WHERE id = 'ws-attached'`).get()).toEqual({
      id: 'ws-attached',
      project_id: null,
    });
  });
});
