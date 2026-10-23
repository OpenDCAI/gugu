import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0039 assistant activity', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('upgrades a resource-history profile without losing its samples', async () => {
    fixture = await openFixture('empty', { through: '0038_resource_history' });
    fixture.sqlite.exec("INSERT INTO resource_history (timestamp, run_id, bytes, snapshot) VALUES (123, 'existing-run', 2, '{}')");
    const migration = bundledMigrations().find((entry) => entry.tag === '0039_assistant_activity')!;
    applyMigrations(fixture.sqlite, [migration]);
    expect(fixture.sqlite.prepare('SELECT run_id FROM resource_history').all()).toEqual([{ run_id: 'existing-run' }]);
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM activity_events').get()).toEqual({ n: 0 });
    expect(fixture.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('records the project of existing sessions and of every session inserted later, and keeps it after deletion', async () => {
    fixture = await openFixture('empty', { through: '0037_project_root_detach' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P1', '/p1'), ('p2', 'P2', '/p2');
      INSERT INTO sessions (id, project_id, title) VALUES ('before', 'p1', 'existing');
    `);
    const migration = bundledMigrations().find((entry) => entry.tag === '0039_assistant_activity');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);

    sql.exec(`INSERT INTO sessions (id, project_id, title) VALUES ('after', 'p2', 'created later')`);
    sql.exec(`DELETE FROM sessions`);
    expect(sql.prepare('SELECT session_id, project_id FROM activity_session_projects ORDER BY session_id').all()).toEqual([
      { session_id: 'after', project_id: 'p2' },
      { session_id: 'before', project_id: 'p1' },
    ]);
    expect(sql.pragma('foreign_key_check')).toEqual([]);
  });
});
