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

import { eq } from 'drizzle-orm';
import { sessions } from '@main/db/schema';
import { enqueuePending, lifeStore } from './session-pending';
import { storedPendingInputLookup } from './session-pending-history';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { initializeDatabase } from '@main/db/initialize';

const source = (messageId: string) => ({ agentUserId: 'agent', row: { id: messageId, chatId: 'chat', seq: 1 } as never });
const batch = (messageId: string, ids: string[]) =>
  ({ sessionId: 's', text: messageId, kind: 'inbox-batch' as const, sources: ids.map(source) });

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

  it.each([2, 3])('gives %i recipients independent local bodies for one cloud message', (count) => {
    const recipients = Array.from({ length: count }, (_, i) => `recipient-${i}`);
    const pending = recipients.map((sessionId, i) => {
      fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, title) VALUES (?, 'p', 'root', 'Recipient')").run(sessionId);
      const input = { sessionId, text: `for agent ${i}`, kind: 'inbox-batch' as const,
        sources: [{ ...source('cloud-message'), agentUserId: `agent-${i}` }] };
      const row = enqueuePending(input);
      expect(enqueuePending(input)).toEqual({ inserted: false, seq: row.seq, state: 'queued' });
      expect(lifeStore.row(sessionId, row.seq).sources).toEqual(input.sources);
      return { sessionId, seq: row.seq, id: lifeStore.row(sessionId, row.seq).message.id };
    });
    expect(new Set(pending.map(row => row.id)).size).toBe(count);
    expect(pending.every(row => row.id !== 'cloud-message')).toBe(true);
    for (const [index, row] of pending.entries()) {
      lifeStore.commit(row.sessionId, [{ e: 'write-receipt', seq: row.seq, receipt: { state: 'accepted', nativeReceiptId: `native-${index}` } }]);
      expect(lifeStore.pending(row.sessionId)).toEqual({ queued: [], dispatching: [] });
      for (const other of pending.slice(index + 1)) expect(lifeStore.pending(other.sessionId).queued).toEqual([other.seq]);
    }
  });

  it('rejects changed content even when the same local input already has a pending receipt', () => {
    enqueuePending({ sessionId: 's', messageId: 'm', text: 'original', kind: 'ordinary' });
    expect(() => enqueuePending({ sessionId: 's', messageId: 'm', text: 'changed', kind: 'ordinary' })).toThrow(/conflicts with its persisted content/);
  });

  it('upgrades a 1131.1 database and retries its blocked delivery without deleting the old owner', async () => {
    fixture.close();
    // Read-only schema inspection of 1131.1 confirmed migration timestamp 1793440000001 (0044).
    fixture = await openFixture('empty', { through: '0044_session_pending' });
    mocks.db = fixture.db;
    fixture.sqlite.exec("INSERT INTO workspaces (id,type,kind,location,path,key) VALUES ('root','local','project-root','local','/repo','root'); INSERT INTO projects (id,name,path,repository_workspace_id) VALUES ('p','P','/repo','root'); INSERT INTO sessions (id,project_id,workspace_id,title) VALUES ('s','p','root','T')");
    fixture.sqlite.exec("INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('other', 'p', 'root', 'Other'); INSERT INTO messages (id, session_id, content, sender, metadata) VALUES ('cloud-message', 'other', 'legacy', 'user', '{\"kind\":\"inbox-batch\"}'); INSERT INTO session_pending (session_id, message_id, kind, state) VALUES ('other', 'cloud-message', 'inbox-batch', 'accepted')");
    fixture.sqlite.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ kind: 'inbox-batch', sources: [source('cloud-message')] }), 'cloud-message');
    fixture.sqlite.exec("INSERT INTO session_pending_source (seq, session_id, source_message_id) SELECT seq, 'other', 'cloud-message' FROM session_pending WHERE session_id = 'other'");
    await initializeDatabase(fixture.sqlite);
    expect(enqueuePending({ sessionId: 'other', text: 'refetched envelope', kind: 'inbox-batch', sources: [source('cloud-message')] })).toMatchObject({ inserted: false, state: 'accepted' });
    const input = { sessionId: 's', text: 'blocked delivery', kind: 'inbox-batch' as const, sources: [source('cloud-message')] };
    const retried = enqueuePending(input);
    expect(lifeStore.row('s', retried.seq).message.id).not.toBe('cloud-message');
    expect(enqueuePending(input)).toEqual({ inserted: false, seq: retried.seq, state: 'queued' });
    lifeStore.commit('s', [{ e: 'write-receipt', seq: retried.seq, receipt: { state: 'accepted', nativeReceiptId: 'native-after-upgrade' } }]);
    expect(lifeStore.pending('s').queued).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT content FROM messages WHERE id = 'cloud-message'").get()).toEqual({ content: 'legacy' });
  });

  it('keeps a rejected inbox item as failed while the next item can be queued and consumed', () => {
    const bad = enqueuePending({ ...batch('bad', ['bad-source']), failure: { name: 'Error', message: 'bad input' } });
    const good = enqueuePending(batch('good', ['good-source']));
    expect(lifeStore.row('s', bad.seq)).toMatchObject({ state: 'failed', failure: { message: 'bad input' } });
    expect(lifeStore.pending('s')).toEqual({ queued: [good.seq], dispatching: [] });
    lifeStore.commit('s', [{ e: 'write-receipt', seq: good.seq, receipt: { state: 'accepted', nativeReceiptId: 'native-good' } }]);
    expect(lifeStore.pending('s').queued).toEqual([]);
    expect(enqueuePending(batch('bad-refetched', ['bad-source']))).toMatchObject({ inserted: false, state: 'failed' });
  });

  it('rejects different source content for the same recipient and source id', () => {
    const input = { sessionId: 's', text: 'envelope', kind: 'inbox-batch' as const,
      sources: [{ agentUserId: 'agent', row: { id: 'source', content: 'original' } as never }] };
    enqueuePending(input);
    expect(() => enqueuePending({ ...input, sources: [{ agentUserId: 'agent', row: { id: 'source', content: 'changed' } as never }] })).toThrow(/conflicts with its persisted content/);
    expect(lifeStore.pending('s').queued).toHaveLength(1);
  });

  it('an exact batch refetch is a duplicate; a subset or a partial overlap is rejected', () => {
    const first = enqueuePending(batch('b1', ['c1', 'c2']));
    expect(enqueuePending(batch('b1-again', ['c2', 'c1']))).toEqual({ inserted: false, seq: first.seq, state: 'queued' });
    expect(() => enqueuePending(batch('b2', ['c1']))).toThrow(/overlaps claimed sources/);
    expect(() => enqueuePending(batch('b3', ['c2', 'c3']))).toThrow(/overlaps claimed sources/);
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM session_pending').get()).toEqual({ n: 1 });
  });

  it('a discard takes the message and its row, and creation turns can not re-admit it', () => {
    fixture.sqlite.prepare("UPDATE sessions SET config = ? WHERE id = 's'").run(JSON.stringify({ version: '1', type: 'acp', agentDisplayName: 'T', firstUtterance: 'first', initialQueue: [{ text: 'first', origin: 'manual' }] }));
    expect(lifeStore.pending('s')).toEqual({ queued: [], dispatching: [] });
    const seeded = fixture.db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, 's')).get();
    expect(seeded?.config, 'the fixture really is a stored config').toMatchObject({ type: 'acp', initialQueue: [{ text: 'first' }] });
    const keep = enqueuePending({ sessionId: 's', messageId: 'keep', text: 'keep', kind: 'ordinary' }).seq;
    const gone = enqueuePending({ sessionId: 's', messageId: 's:creation:0', text: 'first', kind: 'ordinary',
      sources: [source('src')] }).seq;

    lifeStore.commit('s', [{ e: 'delete-row', seq: gone }]);

    expect(fixture.sqlite.prepare("SELECT id FROM messages WHERE session_id = 's' ORDER BY id").all()).toEqual([{ id: 'keep' }]);
    expect(lifeStore.pending('s')).toEqual({ queued: [keep], dispatching: [] });
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM session_pending_source').get(), 'its sources go with the row').toEqual({ n: 0 });
    const after = fixture.db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, 's')).get();
    expect(after?.config).toMatchObject({ type: 'acp' });
    expect(after?.config, 'creation can not re-admit it').not.toHaveProperty('initialQueue');
    expect(() => lifeStore.commit('s', [{ e: 'delete-row', seq: gone }]), 'a row already gone is loud').toThrow(/no pending row/);
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
  it('finds exact input evidence behind more than the renderer byte/page budget and ignores replies', async () => {
    const envelope = (id: string) => renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromType: 'agent', fromId: 'session:sender', messageId: `msg:${id}`, at: '2026-11-06 05:00 UTC+8', content: 'hello' });
    const original = { id: 'original-input-client-id', text: envelope('delivery-1') };
    const insert = fixture.sqlite.prepare('INSERT INTO session_turns (id,session_id,seq,turn_id,data) VALUES (?, ?, ?, ?, ?)');
    const item = { kind: 'message', role: 'user', id: 'native-user', text: original.text, _meta: { guguClientMessageId: original.id } };
    insert.run('s:1', 's', 1, 'oldest', JSON.stringify({ id: 'oldest', seq: 1, outcome: { kind: 'error' }, items: [item] }));
    for (let seq = 2; seq <= 710; seq++) insert.run(`s:${seq}`, 's', seq, `turn-${seq}`, JSON.stringify({ id: `turn-${seq}`, seq, items: [{ kind: 'execute-tool-call', output: 'x'.repeat(1500) }] }));
    insert.run('s:711', 's', 711, 'reply', JSON.stringify({ items: [{ ...item, id: 'assistant', role: 'assistant', text: envelope('absent') }] }));
    const lookup = storedPendingInputLookup('s');
    expect(await lookup(original)).toBe('native-user');
    expect(await lookup({ id: 'different-id', text: envelope('delivery-1') })).toBe('native-user');
    expect(await lookup({ id: 'missing-id', text: envelope('absent') })).toBeNull();
    expect(await storedPendingInputLookup('other')(original)).toBeNull();
  });

});
