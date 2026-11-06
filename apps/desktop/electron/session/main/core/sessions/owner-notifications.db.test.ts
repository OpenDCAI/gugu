import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { startNativeConversationPublicationHost } from './native-publication-host';
import { pendingNativePublications } from './native-publication-journal';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, root: '', sourceTurn: 'runtime-turn' }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('../projects/utils', () => ({ resolveWorkspace: () => ({ path: mocks.root }) }));
vi.mock('./session-activity-source', () => ({ readCurrentTurnIdentity: async () => mocks.sourceTurn }));
const { commitOwnerNotification, ownerNotificationFile } = await import('./owner-notifications');
const { nativeConversationUnread, nativeOwnerNotificationUnread, markNativeConversationVisible } = await import('./session-conversation-read');
const { ownerNotificationHead, ownerNotificationEpoch } = await import('./owner-notification-state');
const { getStoredHistory, persistCommittedTurn, truncateStoredHistory } = await import('./session-turn-store');
let fixture: Awaited<ReturnType<typeof openFixture>>;
let publicationHost: ReturnType<typeof startNativeConversationPublicationHost> | undefined;
const context = { sessionId: 's', projectId: 'p', workspaceId: 'w' };
const input = { request_id: '11111111-1111-4111-8111-111111111111', agent_user_id: 'agent', text: 'The result needs your review' };
const records = () => (fixture.sqlite.prepare('SELECT data FROM session_turns ORDER BY seq').all() as { data: string }[]).map(row => JSON.parse(row.data) as TranscriptTurn);
beforeEach(async () => {
  mocks.sourceTurn = 'runtime-turn';
  mocks.root = await mkdtemp(join(tmpdir(), 'gugu-owner-notification-'));
  fixture = await openFixture(); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id,workspace_id,runtime) VALUES('s','p','w','acp')");
});
afterEach(async () => { publicationHost?.dispose(); publicationHost = undefined; fixture.close(); mocks.db = undefined; await rm(mocks.root, { recursive: true, force: true }); });

it('atomically journals a real explicit owner notification once while offline', async () => {
  publicationHost = startNativeConversationPublicationHost({
    context: async () => ({ ownerUserId: 'owner', deviceId: 'device', agentUserId: 'agent' }),
    address: async () => ({ chatId: 'dm', agentUserId: 'agent' }),
    publish: async () => { throw Error('offline'); }, failed: () => {},
  });
  const receipt = await commitOwnerNotification(context, input, async () => {});
  expect(await commitOwnerNotification(context, input, async () => {})).toEqual(receipt);
  expect(pendingNativePublications()).toHaveLength(1);
  expect(records()[0]!.items[0]).toMatchObject({ _meta: { guguPublicationId: pendingNativePublications()[0]!.id } });
});
it.each(['signed-out', 'rebound'] as const)('does not commit a notification after its publication scope becomes %s', async state => {
  publicationHost = startNativeConversationPublicationHost({
    context: async () => state === 'signed-out' ? null : ({ ownerUserId: 'another', deviceId: 'another-device', agentUserId: 'new-agent' }),
    address: async () => { throw Error('must not address'); }, publish: async () => { throw Error('must not publish'); }, failed: () => {},
  });
  await expect(commitOwnerNotification(context, input, async () => {})).rejects.toThrow(state === 'signed-out' ? 'not authenticated' : 'identity changed');
  expect(records()).toEqual([]);
  expect(pendingNativePublications()).toEqual([]);
});

it('commits once and keeps a confirmed read across an identical retry', async () => {
  const receipt = await commitOwnerNotification(context, input, async () => {});
  expect(receipt).toMatchObject({ status: 'sent', message_id: input.request_id, session_id: 's', seq: 0 });
  const record = records()[0]!;
  expect(record.items[0]).toMatchObject({ kind: 'message', role: 'assistant', text: input.text, ownerNotification: { requestId: input.request_id, sourceTurnId: 'runtime-turn' } });
  expect(nativeConversationUnread('s')).toHaveLength(1);
  expect(nativeOwnerNotificationUnread('s')).toHaveLength(1);
  markNativeConversationVisible('s', [record.items[0]!.id]);
  expect(await commitOwnerNotification(context, input, async () => {})).toEqual(receipt);
  expect(records()).toHaveLength(1);
  expect(nativeConversationUnread('s')).toEqual([]);
  expect(nativeOwnerNotificationUnread('s')).toEqual([]);
  await expect(commitOwnerNotification(context, { ...input, text: 'different request' }, async () => {})).rejects.toThrow('different content');
});
it('retains the sent HTML bytes after the source changes or disappears and authorizes only its recorded path', async () => {
  const source = join(mocks.root, 'report.html');
  await writeFile(source, '<p>version one</p>');
  const fileInput = { ...input, text: '', file: { path: source, name: 'report.html', mime_type: 'text/html' } };
  const receipt = await commitOwnerNotification(context, fileInput, async () => {});
  const message = records()[0]!.items[0]!;
  if (message.kind !== 'message') throw new Error('Expected owner message');
  const file = message.ownerNotification!.files![0]!;
  expect(await readFile(file.path, 'utf8')).toBe('<p>version one</p>');
  expect(ownerNotificationFile('s', file.path)).toBe(true);
  expect(ownerNotificationFile('other', file.path)).toBe(false);
  expect(ownerNotificationFile('s', source)).toBe(false);
  await writeFile(source, '<p>version two</p>'); await unlink(source);
  expect(await commitOwnerNotification(context, fileInput, async () => {})).toEqual(receipt);
  expect(await readFile(file.path, 'utf8')).toBe('<p>version one</p>');
  expect(nativeOwnerNotificationUnread('s')).toHaveLength(1);
});
it('serializes concurrent sends and rejects identity or archival changes before committing', async () => {
  const second = { ...input, request_id: '22222222-2222-4222-8222-222222222222', text: 'second' };
  const receipts = await Promise.all([commitOwnerNotification(context, input, async () => {}), commitOwnerNotification(context, second, async () => {})]);
  expect(receipts.map(row => row.seq).sort()).toEqual([0, 1]);
  await expect(commitOwnerNotification(context, { ...input, request_id: '33333333-3333-4333-8333-333333333333' }, async () => { throw new Error('account changed'); })).rejects.toThrow('account changed');
  await expect(commitOwnerNotification(context, { ...input, request_id: '44444444-4444-4444-8444-444444444444' }, async () => { fixture.sqlite.exec("UPDATE sessions SET archived_at=1 WHERE id='s'"); })).rejects.toThrow('changed before');
  expect(records()).toHaveLength(2);
});

it('deduplicates concurrent identical file sends and refuses a session without a native reader', async () => {
  const source = join(mocks.root, 'report.html');
  await writeFile(source, '<p>durable report</p>');
  const fileInput = { ...input, text: '', file: { path: source, name: 'report.html', mime_type: 'text/html' } };
  const receipts = await Promise.all([commitOwnerNotification(context, fileInput, async () => {}), commitOwnerNotification(context, fileInput, async () => {})]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(records()).toHaveLength(1);
  fixture.sqlite.exec("UPDATE sessions SET runtime='pty' WHERE id='s'");
  await expect(commitOwnerNotification(context, { ...input, request_id: '22222222-2222-4222-8222-222222222222' }, async () => {})).rejects.toThrow('not delivered to your owner');
  expect(records()).toHaveLength(1);
});

it('reverts notifications with their source turn and atomically resets unread, head and the cursor epoch', async () => {
  const provider = (id: string): TranscriptTurn => ({ id, seq: 0, initiator: 'user', items: [{ kind: 'message', id: `${id}:input`, seq: 0, role: 'user', text: 'Work' }] });
  mocks.sourceTurn = 'source-a';
  await commitOwnerNotification(context, input, async () => {}); // notice 0 precedes provider commit 1
  await persistCommittedTurn({ sessionId: 's', source: 'live', turn: provider('source-a') });
  mocks.sourceTurn = 'source-b';
  await commitOwnerNotification(context, { ...input, request_id: '22222222-2222-4222-8222-222222222222' }, async () => {});
  await persistCommittedTurn({ sessionId: 's', source: 'live', turn: provider('source-b') });
  expect(ownerNotificationHead('s')).toBe(2);
  expect(nativeOwnerNotificationUnread('s')).toHaveLength(2);
  await truncateStoredHistory('s', 3);
  expect(records()).toHaveLength(2);
  expect(records()[0]!.items[0]).toMatchObject({ ownerNotification: { requestId: input.request_id } });
  expect(ownerNotificationHead('s')).toBe(0);
  expect(ownerNotificationEpoch('s')).toBe(1);
  expect((await getStoredHistory({ sessionId: 's' })).nativeOwnerNotificationEpoch).toBe(1);
  expect(nativeOwnerNotificationUnread('s')).toHaveLength(1);
  await truncateStoredHistory('s', 1);
  expect(records()).toEqual([]);
  expect(ownerNotificationHead('s')).toBeUndefined();
  expect(ownerNotificationEpoch('s')).toBe(2);
  expect(await getStoredHistory({ sessionId: 's' })).toMatchObject({ turns: [], nativeOwnerNotificationEpoch: 2 });
  expect(nativeConversationUnread('s')).toEqual([]);
  mocks.sourceTurn = 'source-c';
  const receipt = await commitOwnerNotification(context, { ...input, request_id: '33333333-3333-4333-8333-333333333333' }, async () => {});
  expect(receipt.seq).toBe(0);
  expect(ownerNotificationHead('s')).toBe(0);
  expect(ownerNotificationEpoch('s')).toBe(2);
  expect(nativeOwnerNotificationUnread('s')).toHaveLength(1);
});

it('rolls back record deletion and notification metadata if the read journal cannot be truncated', async () => {
  await commitOwnerNotification(context, input, async () => {});
  fixture.sqlite.prepare('UPDATE kv SET value=? WHERE key=?').run('invalid journal', 'native-conversation-read:s');
  await expect(truncateStoredHistory('s', 0)).rejects.toThrow();
  expect(records()).toHaveLength(1);
  expect(ownerNotificationHead('s')).toBe(0);
  expect(ownerNotificationEpoch('s')).toBe(0);
});
