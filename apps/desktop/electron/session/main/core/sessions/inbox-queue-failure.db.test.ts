import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { markInboxRowsRead, pullAgentInbox, resetAgentInboxReaderStateForTests, type AgentInboxReaderDeps, type AgentInboxUnreadRow } from '@gugu/core/local/agent/agentInboxReader';
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery';
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
import { enqueuePending, claimedSessionSources, lifeStore } from './session-pending';
import { SessionLife } from './session-life';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  resetAgentInboxReaderStateForTests();
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO workspaces (id,type,kind,location,path,key) VALUES ('root','local','project-root','local','/repo','root'); INSERT INTO projects (id,name,path,repository_workspace_id) VALUES ('p','P','/repo','root'); INSERT INTO sessions (id,project_id,workspace_id,title) VALUES ('s','p','root','T')");
});
afterEach(() => { resetAgentInboxReaderStateForTests(); fixture.close(); mocks.db = undefined; });
const AGENT = '00000000-0000-4000-8000-000000000001';
const CHAT = '00000000-0000-4000-8000-000000000002';
const HUMAN = '00000000-0000-4000-8000-000000000003';
const row = (seq: number): AgentInboxUnreadRow => ({
  id: `00000000-0000-4000-8000-${String(seq + 10).padStart(12, '0')}`, seq, chatId: CHAT, chatKind: 'group', chatPublicId: 1, chatName: 'Group', chatCreatorUserId: HUMAN,
  groupRules: '', listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0, senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Sender', senderGuguNumber: null,
  content: seq === 1 ? 'bad payload' : 'good payload', contentType: 'text', toUserIds: [AGENT], isWhisper: false, replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
  threadRootId: null, isThreadRoot: false, createdAt: '2026-11-02T00:00:00Z',
});

it('persists one rejected item, discloses a terminal failure, and admits the following item through the real reader/store', async () => {
  const cloudRows = [row(1), row(2)]; const read = new Set<string>();
  const publish = vi.fn();
  const life = new SessionLife({ logger: { info: () => {} }, sessions: () => ['s'], store: () => lifeStore, adapter: () => { throw new Error('Must not start a provider'); },
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true, markRead: async () => {}, reportFailure: async () => {},
    publish, removed: vi.fn(), failed: vi.fn(), now: Date.now });
  const postDisclosure = vi.fn(async () => {});
  const deps: AgentInboxReaderDeps = {
    accessToken: 'fixture', groupRulesLedger: memoryGroupRulesLedger(), deliveryTiming: () => 'next-tool-call',
    fetchUnread: async () => cloudRows.filter(message => !read.has(message.id)),
    claimedSources: (_agent, ids) => claimedSessionSources('s', ids),
    queuesInbox: () => true,
    inject: async input => {
      if (input.sources?.some(source => source.row.id === cloudRows[0]!.id)) throw new Error('invalid payload');
      enqueuePending({ sessionId: 's', text: input.text, kind: 'inbox-batch', sources: input.sources!.map(source => ({ ...source, agentUserId: AGENT })) });
      return 'enqueued';
    },
    recordFailure: async (input, cause) => life.rejectInbox({ sessionId: 's', text: input.text, kind: 'inbox-batch', sources: input.sources!.map(source => ({ ...source, agentUserId: AGENT })) }, cause),
    markRead: async input => { read.add(input.messageId); }, postDisclosure,
  };
  await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('invalid payload');
  const pending = lifeStore.unaccepted('s');
  expect(pending.map(item => item.state)).toEqual(['failed', 'queued']);
  expect(pending.map(item => item.sources[0]!.row.id)).toEqual(cloudRows.map(item => item.id));
  expect(pending.every(item => !cloudRows.some(cloud => cloud.id === item.message.id))).toBe(true);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ pending: expect.objectContaining({ items: [expect.objectContaining({ state: 'failed', failure: 'invalid payload' })] }) }));
  expect(postDisclosure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: expect.stringMatching(/^delivery-rejected:/), reason: 'deliveryRejected' }));
  expect(read.size).toBe(0); // Failed is never falsely acknowledged as an agent read.
  lifeStore.commit('s', [{ e: 'write-receipt', seq: pending[1]!.seq, receipt: { state: 'accepted', nativeReceiptId: 'native-good' } }]);
  await markInboxRowsRead(AGENT, pending[1]!.sources, deps);
  expect(lifeStore.pending('s').queued).toEqual([]);
  expect([...read]).toEqual([cloudRows[1]!.id]);
  resetAgentInboxReaderStateForTests(); // A reader restart uses the persisted failed source, not a process-local skip.
  await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 0 });
  expect(postDisclosure).toHaveBeenCalledTimes(1);
});

it('an archived queue row stays unread and is not delivered again after a restart and a restore', async () => {
  const cloudRows = [row(3)]; const read = new Set<string>();
  const reportFailure = vi.fn(async () => {});
  const life = new SessionLife({ logger: { info: () => {} }, sessions: () => ['s'], store: () => lifeStore, adapter: () => { throw new Error('Must not start a provider'); },
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true, markRead: async () => {}, reportFailure,
    publish: vi.fn(), removed: vi.fn(), failed: vi.fn(), now: Date.now });
  const inject = vi.fn(async () => 'enqueued' as const);
  const deps: AgentInboxReaderDeps = {
    accessToken: 'fixture', groupRulesLedger: memoryGroupRulesLedger(), deliveryTiming: () => 'next-tool-call',
    fetchUnread: async () => cloudRows.filter(message => !read.has(message.id)),
    claimedSources: (_agent, ids) => claimedSessionSources('s', ids),
    queuesInbox: () => true, inject,
    markRead: async input => { read.add(input.messageId); }, postDisclosure: vi.fn(async () => {}),
  };
  enqueuePending({ sessionId: 's', text: 'queued', kind: 'inbox-batch', sources: [{ row: cloudRows[0]!, agentUserId: AGENT }] });
  await life.interrupt('s', { k: 'interrupt', reason: 'archive' });
  expect(reportFailure).toHaveBeenCalledOnce();
  expect(lifeStore.pending('s').queued).toEqual([]);
  life.restore('s'); await life.quiescent('s');
  resetAgentInboxReaderStateForTests();
  await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 1, injected: 0 });
  expect(inject).not.toHaveBeenCalled();
  expect(read.size).toBe(0);
});
