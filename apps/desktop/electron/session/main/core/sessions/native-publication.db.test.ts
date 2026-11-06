import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { nativeInputPublication, pendingNativePublications, queueNativeInput, queueNativePublication, type NativePublicationContext } from './native-publication-journal';
import { startNativeConversationPublicationHost } from './native-publication-host';
import { recordNativePublicationTurn } from './native-publication-turn';
import { persistCommittedTurn } from './session-turn-store';
import { enqueuePending } from './session-pending';
let fixture: Awaited<ReturnType<typeof openFixture>>;
let host: ReturnType<typeof startNativeConversationPublicationHost> | undefined;
const owner: NativePublicationContext = { ownerUserId: 'owner-a', deviceId: 'device-a', agentUserId: 'agent-a' };
const at = '2026-11-01T12:00:00.000Z';
const address = async () => ({ chatId: 'dm-a', agentUserId: 'agent-a' });
const record = (): TranscriptTurn => ({ id: 'runtime:turn:0', referenceId: 'immutable-turn-a', seq: 7,
  initiator: 'user', trigger: { kind: 'owner' }, startedAt: Date.parse(at), endedAt: Date.parse(at) + 1,
  items: [{ kind: 'message', id: 'provider-user', role: 'user', seq: 0, text: 'hello', _meta: { guguClientMessageId: 'input-a' } },
    { kind: 'message', id: 'provider-reply', role: 'assistant', seq: 1, text: 'reply' }] });
beforeEach(async () => {
  fixture = await openFixture('empty'); mock.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id) VALUES('s','p')");
});
afterEach(() => { host?.dispose(); host = undefined; fixture.close(); mock.db = undefined; });

it('rolls the publication back with rejected local admission, and never reconstructs it from history', () => {
  expect(() => fixture.db.transaction(tx => { queueNativeInput(owner, 's', 'input-a', at, tx); throw Error('admission failed'); })).toThrow('admission failed');
  expect(pendingNativePublications()).toEqual([]);
  expect(nativeInputPublication('s', 'input-a')).toBeUndefined();
  for (const source of ['revision', 'backfill'] as const) recordNativePublicationTurn({ sessionId: 's', rowId: 'old', source, turn: record(), context: owner }, fixture.db);
  expect(pendingNativePublications()).toEqual([]);
});

it('stores input and publication atomically once through the real lifecycle admission', () => {
  const input = { sessionId: 's', messageId: 'input-a', text: 'hello', kind: 'ordinary' as const, personalPublication: owner };
  expect(enqueuePending(input).inserted).toBe(true);
  const original = pendingNativePublications()[0]!;
  expect(enqueuePending(input).inserted).toBe(false);
  expect(pendingNativePublications()).toEqual([original]);
  expect(nativeInputPublication('s', 'input-a')?.id).toBe(original.id);
  enqueuePending({ ...input, messageId: 'background', kind: 'session-direct' });
  expect(pendingNativePublications()).toHaveLength(1);
});

it('uses the original input owner and UUID at settlement, then keeps reply IDs across aliases and late revisions', () => {
  const input = queueNativeInput(owner, 's', 'input-a', at, fixture.db);
  const foreign = { ownerUserId: 'owner-b', deviceId: 'device-b', agentUserId: 'agent-b' };
  const first = recordNativePublicationTurn({ sessionId: 's', rowId: 's:10', source: 'live', turn: record(), context: foreign }, fixture.db);
  const pending = pendingNativePublications();
  expect(pending).toHaveLength(2);
  expect(pending.every(entry => entry.ownerUserId === owner.ownerUserId)).toBe(true);
  expect(first.items[0]).toMatchObject({ _meta: { guguPublicationId: input.id, guguPublicationAt: at } });
  const revised = { ...first, seq: 10, endedAt: Date.parse(at) + 500, items: first.items.map(item => ({ ...item, id: 'new-provider-alias:' + item.id })) };
  const second = recordNativePublicationTurn({ sessionId: 's', rowId: 's:10', source: 'revision', turn: revised, context: null }, fixture.db);
  expect(pendingNativePublications()).toEqual(pending);
  expect(second.items[1]).toMatchObject({ _meta: { guguPublicationId: pending[1]!.id, guguPublicationAt: pending[1]!.occurredAt } });
  recordNativePublicationTurn({ sessionId: 's', rowId: 's:10', source: 'revision', context: null, turn: { ...revised,
    items: [...revised.items, { kind: 'message', id: 'late-reply', seq: 2, role: 'assistant', text: 'a genuinely late message' }] } }, fixture.db);
  expect(pendingNativePublications()).toHaveLength(3);
  expect(new Set(pendingNativePublications().map(entry => entry.id)).size).toBe(3);
});

it('publishes attachment-only personal replies and owner notifications, excluding background and NO_REPLY', () => {
  const turn: TranscriptTurn = { ...record(), initiator: 'agent', trigger: { kind: 'delivery' }, items: [
    { kind: 'message', id: 'background', seq: 0, role: 'assistant', text: 'group work' },
    { kind: 'message', id: 'owner', seq: 1, role: 'user', text: 'my input', _meta: { guguOwnerInput: true } },
    { kind: 'message', id: 'empty', seq: 2, role: 'assistant', text: '[NO_REPLY]' },
    { kind: 'message', id: 'file', seq: 3, role: 'assistant', text: '', files: [{ itemId: 'f', version: 1, name: 'file.txt', mimeType: 'text/plain', sizeBytes: 1 }] },
    { kind: 'message', id: 'delivery', seq: 4, role: 'user', text: 'another delivery', _meta: { guguOwnerInput: false } },
    { kind: 'message', id: 'background-again', seq: 5, role: 'assistant', text: 'group work again' },
    { kind: 'message', id: 'notification', seq: 6, role: 'assistant', text: 'owner action required', ownerNotification: { requestId: 'notification', requestHash: 'fixture' } },
  ] };
  recordNativePublicationTurn({ sessionId: 's', rowId: 's:1', source: 'live', turn, context: owner }, fixture.db);
  expect(pendingNativePublications()).toHaveLength(3);
});

it('retries an uncertain committed publication with its frozen key and destination across restart', async () => {
  const entry = queueNativePublication(owner, 's', at, fixture.db);
  const attempts: unknown[] = [];
  const failed = vi.fn();
  host = startNativeConversationPublicationHost({ context: async () => owner, address,
    publish: async sent => { attempts.push(sent); throw Error('reply lost after server commit'); }, failed });
  await host.flush(); host.dispose();
  expect(pendingNativePublications()[0]).toMatchObject({ id: entry.id, chatId: 'dm-a', occurredAt: at });
  host = startNativeConversationPublicationHost({ context: async () => owner, address: async () => { throw Error('must reuse frozen address'); },
    publish: async sent => { attempts.push(sent); return { accountRevision: '90071992547409931', already: true }; }, failed });
  await host.flush();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(pendingNativePublications()).toEqual([]);
});

it('parks another account’s pending publication and resumes only under its captured owner', async () => {
  const entry = queueNativeInput(owner, 's', 'input-a', at, fixture.db);
  let current = { ...owner, ownerUserId: 'owner-b' };
  const publish = vi.fn(async () => ({ accountRevision: '3', already: false }));
  host = startNativeConversationPublicationHost({ context: async () => current, address, publish, failed: error => { throw error; } });
  await host.flush(); expect(publish).not.toHaveBeenCalled();
  current = owner; await host.flush(); expect(publish).toHaveBeenCalledTimes(1);
  expect(queueNativeInput(owner, 's', 'input-a', at, fixture.db)).toMatchObject({ id: entry.id, ack: { accountRevision: '3' } });
  expect(pendingNativePublications()).toEqual([]);
});

it('wires live transcript commits to the journal but leaves replay and old-row revision silent', async () => {
  host = startNativeConversationPublicationHost({ context: async () => owner, address,
    publish: async () => { throw Error('offline'); }, failed: () => {} });
  await persistCommittedTurn({ sessionId: 's', source: 'replay', turn: { ...record(), seq: 0 } });
  await persistCommittedTurn({ sessionId: 's', source: 'revision', turn: record() });
  expect(pendingNativePublications()).toEqual([]);
  const live = { ...record(), id: 'runtime:turn:1', referenceId: 'new-live-turn', seq: 1 };
  await persistCommittedTurn({ sessionId: 's', source: 'live', turn: live });
  expect(pendingNativePublications()).toHaveLength(2);
  const stored = fixture.sqlite.prepare('SELECT data FROM session_turns WHERE turn_id=?').get(live.id) as { data: string };
  expect(JSON.parse(stored.data).items[1]._meta.guguPublicationId).toBe(pendingNativePublications()[1]!.id);
  await persistCommittedTurn({ sessionId: 's', source: 'revision', turn: { ...live, endedAt: live.endedAt! + 20 } });
  expect(pendingNativePublications()).toHaveLength(2);
});
