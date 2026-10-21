import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0037 project root membership', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('keeps existing roots attached and preserves archived sessions and workspaces', async () => {
    fixture = await openFixture('empty', { through: '0036_project_folders' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('root', 'project-root', 'local', 'local', '/repo', 'root-key');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p1', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, archived_at) VALUES ('s1', 'p1', 'root', 'history', '2026-10-19');
    `);
    const migration = bundledMigrations().find((entry) => entry.tag === '0037_project_root_detach');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);
    expect(sql.prepare('SELECT root_folder_detached FROM projects').get()).toEqual({ root_folder_detached: 0 });
    sql.exec(`UPDATE projects SET root_folder_detached = 1 WHERE id = 'p1'`);
    expect(sql.prepare('SELECT id, project_id, workspace_id, archived_at FROM sessions').all()).toEqual([
      { id: 's1', project_id: 'p1', workspace_id: 'root', archived_at: '2026-10-19' },
    ]);
    expect(sql.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: 'root' }]);
    expect(sql.pragma('foreign_key_check')).toEqual([]);
  });
});
