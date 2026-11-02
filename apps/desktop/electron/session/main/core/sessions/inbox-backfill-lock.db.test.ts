import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { runTurnTextBackfill } from '@main/db/turn-text-backfill-work';
import { pullAgentInbox, resetAgentInboxReaderStateForTests, type AgentInboxReaderDeps, type AgentInboxUnreadRow } from '@gugu/core/local/agent/agentInboxReader';
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
import { enqueuePending, claimedSessionSources, lifeStore } from './session-pending';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let worker: Worker | undefined;
beforeEach(async () => {
  resetAgentInboxReaderStateForTests();
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec(`INSERT INTO projects(id,name,path) VALUES ('p','P','/repo');
    INSERT INTO sessions(id,project_id,title,config) VALUES ('s','p','Recipient','{"version":"1","type":"acp"}');`);
});
afterEach(async () => {
  await worker?.terminate(); worker = undefined;
  resetAgentInboxReaderStateForTests(); fixture.close(); mocks.db = undefined;
});

const AGENT = '00000000-0000-4000-8000-000000000001';
const row: AgentInboxUnreadRow = {
  id: '00000000-0000-4000-8000-000000000004', seq: 1, chatId: '00000000-0000-4000-8000-000000000002', chatKind: 'group',
  chatPublicId: 1, chatName: 'Group', chatCreatorUserId: AGENT, groupRules: '', listenMode: 'active', notificationLevel: 'all',
  lastReadSeq: 0, senderUserId: '00000000-0000-4000-8000-000000000003', senderType: 'human', senderDisplayName: 'Sender',
  senderGuguNumber: null, content: 'Please read during backfill', contentType: 'text', toUserIds: [AGENT], isWhisper: false,
  replyToMessageId: null, replyToSenderUserId: null, replyToContent: null, threadRootId: null, isThreadRoot: false, createdAt: '2026-11-02T00:00:00Z',
};

it('admits inbox exactly once while a separate search-index writer holds the WAL write lock', async () => {
  // Use a real second thread: blocking busy_timeout on the caller must not stop the writer committing.
  const native = createRequire(resolve('apps/desktop/session-tooling/node-deps/package.json')).resolve('better-sqlite3');
  worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.native);
    const connection = new Database(workerData.database);
    connection.exec('BEGIN IMMEDIATE');
    connection.prepare("INSERT INTO turn_text_rows(session_id,seq,item_id,role,text) VALUES ('s',0,'historical','user','historical search')").run();
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    connection.exec('COMMIT');
    connection.close();
  `, { eval: true, workerData: { native, database: fixture.sqlite.name } });
  const exited = once(worker, 'exit');
  void exited.catch(() => {}); // The awaited message also rejects on worker error.
  await once(worker, 'message');

  const postDisclosure = vi.fn(async () => {});
  const recordFailure = vi.fn(async () => {});
  const deps: AgentInboxReaderDeps = {
    accessToken: 'fixture', groupRulesLedger: memoryGroupRulesLedger(), queuesInbox: () => true,
    fetchUnread: async () => [row], claimedSources: (_agent, ids) => claimedSessionSources('s', ids),
    inject: async input => {
      enqueuePending({ sessionId: 's', text: input.text, kind: 'inbox-batch', sources: input.sources!.map(source => ({ ...source, agentUserId: AGENT })) });
      return 'enqueued';
    },
    recordFailure, postDisclosure, markRead: vi.fn(async () => {}),
  };
  await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1, verdict: 'enqueued' });
  await exited;
  expect(lifeStore.unaccepted('s')).toEqual([expect.objectContaining({ state: 'queued', failure: null })]);
  expect(recordFailure).not.toHaveBeenCalled(); expect(postDisclosure).not.toHaveBeenCalled();
  expect(deps.markRead).not.toHaveBeenCalled();
  await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 0 });
  expect(lifeStore.unaccepted('s')).toHaveLength(1);
});

it('admits an inbox row between committed batches while the real backfill is still incomplete', async () => {
  const insert = fixture.sqlite.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,\'s\',?,?,?)');
  fixture.sqlite.transaction(() => {
    for (let n = 0; n < 401; n++) insert.run(`turn:${n}`, n, `t:${n}`, JSON.stringify({ id: `t:${n}`, items: [{ kind: 'message', id: `m:${n}`, role: 'user', text: 'historical searchable' }] }));
  })();
  fixture.sqlite.exec("DELETE FROM turn_text_rows; DELETE FROM kv WHERE key IN ('turn_text_backfilled','turn_text_backfill_cursor')");
  const backfill = runTurnTextBackfill(fixture.sqlite, () => {});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.sqlite.prepare("SELECT value FROM kv WHERE key='turn_text_backfilled'").get()).toBeUndefined();
    enqueuePending({ sessionId: 's', text: 'during backfill', kind: 'inbox-batch', sources: [{ row, agentUserId: AGENT }] });
    expect(lifeStore.unaccepted('s')).toEqual([expect.objectContaining({ state: 'queued' })]);
  } finally { await backfill; }
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM turn_text_rows').get()).toEqual({ n: 401 });
});
