import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { openFixture } from '@tooling/utils/db';
import { buildSessionDirectEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TaskExchangePage } from '@shared/core/sessions/task-collaboration';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('Missing test database'); return state.db; } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

import { readTaskExchanges, readAssistantWorkReceipts, taskExchangeRecorded, unwatchTaskExchanges, watchTaskExchanges } from './task-exchanges';

describe('saved task exchange read and push', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    state.db = fixture.db;
    fixture.sqlite.exec(`INSERT INTO projects (id,name,path) VALUES ('p','Project','/repo');
      INSERT INTO sessions (id,project_id,title,provider,runtime,config) VALUES ('task','p','Task','codex','acp','{"version":"1","type":"acp"}');`);
  });
  afterEach(() => { unwatchTaskExchanges('test'); fixture.close(); state.db = undefined; });
  const write = (id: string, sender: string, receipt = 'accepted') => {
    const text = buildSessionDirectEnvelope({ senderSessionId: sender, senderTitle: sender, messageId: id, content: `report ${id}`, at: '2026-10-16 20:00 北京时间' });
    fixture.sqlite.prepare('INSERT INTO messages (id,session_id,content,sender,metadata) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'task', text, 'user', JSON.stringify({ kind: 'session-direct', state: receipt }));
  };
  it('exports accepted local receipts for background upload while advancing past unaccepted input',()=>{
    write('accepted','assistant');write('queued','assistant','queued');write('failed','assistant','failed');
    const page=readAssistantWorkReceipts(0)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({id:'accepted',sessionId:'task',title:'Task'})
    expect(page.cursor).toBe(3)
    expect(readAssistantWorkReceipts(page.cursor).entries).toEqual([])
  })
  it('reads historical accepted messages from the exact pair, without requiring a live provider', () => {
    write('one', 'assistant'); write('other', 'other-task'); write('failed', 'assistant', 'failed');
    const page = readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' });
    expect(page.entries.map((entry) => entry.id)).toEqual(['one']);
    expect(page.cursor).toBe(3);
    expect(readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant', after: page.cursor }).entries).toEqual([]);
  });
  it('advances the scan cursor across unrelated receipts so old assistant inboxes can be fully paged', () => {
    for (let i = 0; i < 200; i++) write(`unrelated-${i}`, 'other-task');
    write('wanted', 'assistant');
    const first = readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' });
    expect(first).toMatchObject({ entries: [], cursor: 200, hasMore: true });
    const second = readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant', after: first.cursor });
    expect(second.entries.map((entry) => entry.id)).toEqual(['wanted']);
    expect(second.hasMore).toBe(false);
  });
  it('notifies only a subscribed recipient after commit, and stops after unsubscribe', () => {
    const changed = vi.fn(() => readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' }));
    watchTaskExchanges('test', { conversationId: 'task', fromSessionId: 'assistant' }, changed);
    write('live', 'assistant'); taskExchangeRecorded('unrelated');
    expect(changed).not.toHaveBeenCalled();
    taskExchangeRecorded('task');
    const page: TaskExchangePage = changed.mock.results[0]!.value;
    expect(page.entries.map((entry) => entry.id)).toEqual(['live']);
    unwatchTaskExchanges('test'); taskExchangeRecorded('task');
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('reports missing sessions and invalid cursors instead of an empty successful history', () => {
    expect(() => readTaskExchanges({ conversationId: 'gone', fromSessionId: 'assistant' })).toThrow('missing');
    expect(() => readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant', after: -1 })).toThrow('cursor');
  });
});
