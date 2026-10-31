// The custody chain: one message id has exactly one owner at a time — the sender's outbox until the host's
// session_pending accepts it, then the host row. Real outbox (IndexedDB) + real session_pending (SQLite).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { enqueuePending } from './session-pending';
import { openSessionInputStorage, SessionInputOutbox } from '../../../../../src/lib/sessionInputOutbox';

describe('custody chain: sender outbox → host session_pending', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, runtime) VALUES ('s', 'p', 'root', 'T', 'acp');
    `);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  const hostRows = () => (fixture.sqlite.prepare("SELECT message_id FROM session_pending WHERE session_id = 's'").all() as { message_id: string }[]).map(row => row.message_id);

  it('host acceptance empties the outbox in the same step; a lost reply is retried into the same single host row', async () => {
    let loseReply = true;
    const outbox = new SessionInputOutbox('owner', await openSessionInputStorage(new IDBFactory()), async input => {
      enqueuePending({ sessionId: input.sessionId, messageId: input.id, text: input.text, kind: 'session-direct' });
      if (loseReply) { loseReply = false; throw new Error('reply lost on the way back'); }
    }, () => true);

    const input = await outbox.enqueue({ deviceId: null, sessionId: 's', text: 'hello' });
    await outbox.flush();
    // The host has it, but the sender never heard back: it still holds its copy (sending, retry).
    expect(hostRows()).toEqual([input.id]);
    expect((await outbox.list()).map(row => row.id)).toEqual([input.id]);

    await outbox.flush();
    expect(hostRows()).toEqual([input.id]);
    expect(await outbox.list()).toEqual([]);

    const second = await outbox.enqueue({ deviceId: null, sessionId: 's', text: 'hello' });
    await outbox.flush();
    // Same words, a new id: a second message, never merged into the first.
    expect(hostRows()).toEqual([input.id, second.id]);
    expect(await outbox.list()).toEqual([]);
  });
});
