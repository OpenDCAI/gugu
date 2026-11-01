import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { sessions } from '../../schema';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0043 task name', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('moves every legacy name into the pending-bind record; the title column stays only for the previous release', async () => {
    fixture = await openFixture('empty', { through: '0041_project_archival' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, config) VALUES
        ('v1', 'p', '修登录页', 'claude', '{"version":"1","type":"acp","model":"m"}'),
        ('named', 'p', 'Old title', 'claude', '{"version":"1","type":"pty","agentDisplayName":"Chosen"}'),
        ('blank-name', 'p', 'Shown title', 'claude', '{"version":"1","type":"pty","agentDisplayName":"  "}'),
        ('no-config', 'p', '  Trimmed  ', 'codex', NULL),
        ('v0', 'p', 'Unversioned', 'claude', '{"model":"sonnet"}'),
        ('empty-title', 'p', '   ', 'codex', '{"version":"1","type":"pty"}');
    `);
    const migration = bundledMigrations().find((entry) => entry.tag === '0043_task_name');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);

    // A rollback runs the previous release on this database, and it selects `title`: the column stays,
    // holding the name each row showed, and defaults for rows this release creates.
    const titles = Object.fromEntries(
      (sql.prepare('SELECT id, title FROM sessions').all() as Array<{ id: string; title: string }>).map((row) => [row.id, row.title])
    );
    expect(titles).toEqual({
      v1: '修登录页', named: 'Chosen', 'blank-name': 'Shown title', 'no-config': 'Trimmed', v0: 'Unversioned', 'empty-title': 'codex',
    });
    sql.exec(`INSERT INTO sessions (id, project_id, config) VALUES ('later', 'p', '{"version":"1","type":"pty","agentDisplayName":"L"}')`);
    expect(sql.prepare(`SELECT title FROM sessions WHERE id = 'later'`).get()).toEqual({ title: '' });
    sql.exec(`DELETE FROM sessions WHERE id = 'later'`);

    // Read through the versioned config column, the way every reader sees it (v0 upgrades on read).
    const names = Object.fromEntries(
      (await fixture.db.select({ id: sessions.id, config: sessions.config }).from(sessions)).map((row) => [
        row.id,
        row.config?.agentDisplayName,
      ])
    );
    expect(names).toEqual({
      v1: '修登录页',
      named: 'Chosen',
      'blank-name': 'Shown title',
      'no-config': 'Trimmed',
      v0: 'Unversioned',
      // A row that never showed a name keeps its engine's id, the only name it can be addressed by.
      'empty-title': 'codex',
    });
    const raw = Object.fromEntries(
      (sql.prepare('SELECT id, config FROM sessions').all() as Array<{ id: string; config: string }>).map((row) => [
        row.id,
        JSON.parse(row.config),
      ])
    );
    expect(raw.v1).toEqual({ version: '1', type: 'acp', model: 'm', agentDisplayName: '修登录页' });
    expect(raw['no-config']).toEqual({ agentDisplayName: 'Trimmed' });
    expect(raw.v0).toEqual({ model: 'sonnet', agentDisplayName: 'Unversioned' });
  });
});
