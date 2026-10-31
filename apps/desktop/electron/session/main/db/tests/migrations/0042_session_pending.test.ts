import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0042 session pending', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('moves the config outbox and explicit receipts into session_pending and clears the old fields', async () => {
    fixture = await openFixture('empty', { through: '0041_project_archival' });
    const sql = fixture.sqlite;
    const outbox = JSON.stringify({ messageOutbox: [
      { id: 'm-queued', text: 'first' },
      { id: 'm-dispatching', text: 'second', state: 'dispatching' },
      { id: 'm-direct', text: 'third', kind: 'session-direct' },
    ], spawnStartupState: 'starting', name: 'kept' });
    sql.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, config, runtime) VALUES ('s', 'p', 'root', 'T', '${outbox}', 'acp');
      INSERT INTO sessions (id, project_id, workspace_id, title, config) VALUES ('pty', 'p', 'root', 'P', '${outbox.replaceAll('m-', 'p-')}');
      INSERT INTO messages (id, session_id, content, sender, metadata) VALUES
        ('m-unknown', 's', 'lost', 'user', '{"kind":"ordinary-message","state":"outcome-unknown"}'),
        ('m-accepted', 's', 'done', 'user', '{"kind":"session-direct","state":"accepted","nativeReceiptId":"r1"}');
    `);
    const migration = bundledMigrations().find(entry => entry.tag === '0042_session_pending');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);
    expect(sql.prepare('SELECT message_id, kind, state, native_receipt_id FROM session_pending ORDER BY seq').all()).toEqual([
      { message_id: 'm-queued', kind: 'ordinary', state: 'queued', native_receipt_id: null },
      { message_id: 'm-dispatching', kind: 'ordinary', state: 'dispatching', native_receipt_id: null },
      { message_id: 'm-direct', kind: 'session-direct', state: 'queued', native_receipt_id: null },
      { message_id: 'm-unknown', kind: 'ordinary', state: 'unknown', native_receipt_id: null },
      { message_id: 'm-accepted', kind: 'session-direct', state: 'accepted', native_receipt_id: 'r1' },
    ]);
    expect(sql.prepare('SELECT content FROM messages WHERE id = ?').get('m-direct')).toEqual({ content: 'third' });
    expect(JSON.parse((sql.prepare("SELECT config FROM sessions WHERE id = 's'").get() as { config: string }).config)).toEqual({ name: 'kept' });
    // A leg not yet in session-life keeps its own queue untouched.
    expect(JSON.parse((sql.prepare("SELECT config FROM sessions WHERE id = 'pty'").get() as { config: string }).config)).toEqual(JSON.parse(outbox.replaceAll('m-', 'p-')));
    expect(sql.prepare("SELECT count(*) AS n FROM session_pending WHERE session_id = 'pty'").get()).toEqual({ n: 0 });
    expect(sql.prepare("SELECT count(*) AS n FROM messages WHERE json_extract(metadata,'$.state') IS NOT NULL").get()).toEqual({ n: 0 });
    expect(sql.prepare("SELECT life_hold FROM sessions WHERE id = 's'").get()).toEqual({ life_hold: null });
    expect(sql.pragma('foreign_key_check')).toEqual([]);
  });
});
