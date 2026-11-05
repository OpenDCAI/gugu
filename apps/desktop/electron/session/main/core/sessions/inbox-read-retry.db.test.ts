import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { markInboxRowsRead, pullAgentInbox, resetAgentInboxReaderStateForTests, type AgentInboxReaderDeps, type AgentInboxUnreadRow } from '@gugu/core/local/agent/agentInboxReader';
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery';
import { until } from '../../../../../../../tests/support/awaitCondition';
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
import { claimedSessionSources, lifeStore } from './session-pending';
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
const message: AgentInboxUnreadRow = {
  id: '00000000-0000-4000-8000-000000000011', seq: 1, chatId: CHAT, chatKind: 'group', chatPublicId: 1, chatName: 'Group', chatCreatorUserId: HUMAN,
  groupRules: '', listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0, senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Sender', senderGuguNumber: null,
  content: '@agent merged', contentType: 'text', toUserIds: [AGENT], isWhisper: false, replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
  threadRootId: null, isThreadRoot: false, createdAt: '2026-11-05T08:26:10Z',
};

it('an accepted message whose read receipt failed says nothing in the chat and is marked read by the next pull', async () => {
  const read = new Set<string>();
  let receiptFails = true;
  const postDisclosure = vi.fn(async () => {});
  const deps: AgentInboxReaderDeps = {
    accessToken: 'fixture', groupRulesLedger: memoryGroupRulesLedger(),
    fetchUnread: async () => read.has(message.id) ? [] : [message],
    claimedSources: (_agent, ids) => claimedSessionSources('s', ids),
    queuesInbox: () => true,
    inject: async input => {
      life.enqueue({ sessionId: 's', text: input.text, kind: 'inbox-batch', sources: input.sources!.map(source => ({ ...source, agentUserId: AGENT })) });
      return 'enqueued';
    },
    markRead: async input => {
      if (receiptFails) throw new Error('TypeError: fetch failed');
      read.add(input.messageId);
    },
    postDisclosure,
  };
  // The host's session-life source port, as main.ts wires it: an accepted row is settled through the reader.
  const life: SessionLife = new SessionLife({ logger: { info: () => {} }, sessions: () => ['s'], store: () => lifeStore, adapter: () => { throw new Error('Must not start a provider'); },
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true,
    markRead: row => markInboxRowsRead(AGENT, row.sources, deps), reportFailure: async () => {},
    publish: vi.fn(), removed: vi.fn(), failed: vi.fn(), now: Date.now });

  await pullAgentInbox(AGENT, deps);
  const [queued] = lifeStore.unaccepted('s');
  expect(queued!.state).toBe('queued');
  // The busy agent takes it; writing its read receipt fails.
  lifeStore.commit('s', [{ e: 'write-receipt', seq: queued!.seq, receipt: { state: 'accepted', nativeReceiptId: 'native-1' } }]);
  life.reconcileRead('s', queued!.seq);
  await until('the failed read receipt leaves the row accepted and unsettled', () => lifeStore.acceptedUnsettled('s'), seqs => seqs.length === 1);
  expect(read.size).toBe(0);
  expect(postDisclosure).not.toHaveBeenCalled();

  // The next pull refetches the still-unread message; the duplicate retries the read receipt instead of being dropped.
  receiptFails = false;
  await pullAgentInbox(AGENT, deps);
  await until('the refetch writes the read receipt', () => [...read], ids => ids.length === 1);
  expect([...read]).toEqual([message.id]);
  await until('the row is settled', () => lifeStore.acceptedUnsettled('s'), seqs => seqs.length === 0);
  expect(lifeStore.unaccepted('s')).toHaveLength(0);
  expect(postDisclosure).not.toHaveBeenCalled();
});
