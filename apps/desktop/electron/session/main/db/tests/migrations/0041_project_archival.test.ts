import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0041 project archival', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('keeps existing project visibility, directory identities and historical tasks', async () => {
    fixture = await openFixture('empty', { through: '0040_project_kind' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, archived_at) VALUES ('s', 'p', 'root', 'History', '2026-10-29');
    `);
    const migration = bundledMigrations().find(entry => entry.tag === '0041_project_archival');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);
    expect(sql.prepare('SELECT archived_at, root_folder_detached, repository_workspace_id FROM projects').get())
      .toEqual({ archived_at: null, root_folder_detached: 0, repository_workspace_id: 'root' });
    expect(sql.prepare('SELECT id, project_id, workspace_id, archived_at FROM sessions').all())
      .toEqual([{ id: 's', project_id: 'p', workspace_id: 'root', archived_at: '2026-10-29' }]);
    expect(sql.pragma('foreign_key_check')).toEqual([]);
  });
});
