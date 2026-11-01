import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { Seq } from '@gugu/core/local/session-life/types';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { enqueuePending, lifeStore } from './session-pending';

const source = (messageId: string) => ({ agentUserId: 'agent', row: { id: messageId, chatId: 'chat', seq: 1 } as never });
const batch = (messageId: string, ids: string[]) =>
  ({ sessionId: 's', messageId, text: messageId, kind: 'inbox-batch' as const, sources: ids.map(source) });

describe('session_pending store', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s', 'p', 'root', 'T');
    `);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  it('inserts once; the same message id returns the existing row without a second body', () => {
    const first = enqueuePending({ sessionId: 's', messageId: 'm1', text: 'hello', kind: 'ordinary' });
    expect(first).toMatchObject({ inserted: true, state: 'queued' });
    expect(enqueuePending({ sessionId: 's', messageId: 'm1', text: 'hello', kind: 'ordinary' })).toEqual({ inserted: false, seq: first.seq, state: 'queued' });
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 'm1'").get()).toEqual({ n: 1 });
    expect(lifeStore.pending('s')).toEqual({ queued: [first.seq], dispatching: [] });
  });

  it('an exact batch refetch is a duplicate; a subset or a partial overlap is rejected', () => {
    const first = enqueuePending(batch('b1', ['c1', 'c2']));
    expect(enqueuePending(batch('b1-again', ['c2', 'c1']))).toEqual({ inserted: false, seq: first.seq, state: 'queued' });
    expect(() => enqueuePending(batch('b2', ['c1']))).toThrow(/overlaps claimed sources/);
    expect(() => enqueuePending(batch('b3', ['c2', 'c3']))).toThrow(/overlaps claimed sources/);
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM session_pending').get()).toEqual({ n: 1 });
  });

  it('commits receipts and holds in one transaction and claims interrupted dispatches as unknown', () => {
    const a = enqueuePending({ sessionId: 's', messageId: 'a', text: 'a', kind: 'ordinary' }).seq;
    const b = enqueuePending({ sessionId: 's', messageId: 'b', text: 'b', kind: 'ordinary' }).seq;
    lifeStore.commit('s', [
      { e: 'write-receipt', seq: a, receipt: { state: 'accepted', nativeReceiptId: 'n1' } },
      { e: 'write-receipt', seq: b, receipt: { state: 'dispatching', attempt: 3 as never } },
      { e: 'write-hold', hold: { reason: 'user-stop', barrier: b } },
    ]);
    expect(lifeStore.read('s')).toEqual({ archived: false, hold: { reason: 'user-stop', barrier: b } });
    expect(lifeStore.acceptedUnsettled('s')).toEqual([a]);
    lifeStore.claim('s');
    expect(lifeStore.row('s', b).state).toBe('unknown');
    expect(() => lifeStore.commit('s', [{ e: 'write-receipt', seq: 999 as Seq, receipt: { state: 'unknown' } }])).toThrow(/no pending row/);
    lifeStore.settleRead('s', a);
    expect(lifeStore.acceptedUnsettled('s')).toEqual([]);
  });
});
