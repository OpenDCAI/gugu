import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { openFixture } from '@tooling/utils/db';
import { buildSessionDirectEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TaskExchangePage } from '@shared/core/sessions/task-collaboration';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('Missing test database'); return state.db; } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../sessions/session-life', async () => {
  const { enqueuePending } = await vi.importActual<typeof import('../sessions/session-pending')>('../sessions/session-pending');
  return { sessionLife: () => ({ enqueue: (input: Parameters<typeof enqueuePending>[0]) => enqueuePending(input), start: vi.fn() }) };
});

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
  it('filters unrelated message kinds in SQL and revisits an accepted queued receipt by position',()=>{
    for(let n=0;n<205;n++)fixture.sqlite.prepare('INSERT INTO messages (id,session_id,content,sender,metadata) VALUES (?, ?, ?, ?, ?)').run(`chat-${n}`,'task','Ordinary chat','user','{"kind":"chat"}')
    write('queued-work','assistant','queued')
    fixture.sqlite.prepare('INSERT INTO messages (id,session_id,content,sender,metadata) VALUES (?, ?, ?, ?, ?)').run('ordinary-tail','task','Ordinary chat','user','{"kind":"chat"}')
    const first=readAssistantWorkReceipts(0)
    expect(first).toMatchObject({entries:[],cursor:207,hasMore:false,pending:[206]})
    fixture.sqlite.prepare('UPDATE messages SET metadata=? WHERE id=?').run('{"kind":"session-direct","state":"accepted"}','queued-work')
    expect(readAssistantWorkReceipts(first.cursor,[206]).entries.map(row=>row.id)).toEqual(['queued-work'])
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
  // A session on session-life keeps a message's receipt only on its pending row; the message row carries no state.
  const enqueueLife = async (id: string, sender: string, kind: 'session-direct' | 'ordinary' = 'session-direct') => {
    const { enqueuePending } = await import('../sessions/session-pending');
    const text = buildSessionDirectEnvelope({ senderSessionId: sender, senderTitle: sender, messageId: id, content: `report ${id}`, at: '2026-10-16 20:00 北京时间' });
    return enqueuePending({ sessionId: 'task', messageId: id, text, kind });
  };
  const settle = (id: string, state: string) => fixture.sqlite.prepare('UPDATE session_pending SET state = ? WHERE message_id = ?').run(state, id);

  it('reads a session-life session_message from its pending receipt: accepted is an exchange, queued is not yet', async () => {
    await enqueueLife('direct', 'assistant');
    expect(readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' }).entries).toEqual([]);
    settle('direct', 'accepted');
    expect(readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' }).entries.map(entry => entry.id)).toEqual(['direct']);
    expect(readAssistantWorkReceipts(0).entries.map(entry => entry.id)).toEqual(['direct']);
  });

  it('reads a spawn delegation (the child\'s first turn, queued as session-direct) once its pending row is accepted', async () => {
    const { enqueueCreationTurns } = await import('../sessions/session-life-creation');
    const text = buildSessionDirectEnvelope({ senderSessionId: 'assistant', senderTitle: 'assistant', messageId: 'delegation', content: 'do it', at: '2026-10-16 20:00 北京时间' });
    enqueueCreationTurns({ id: 'task', initialQueue: [{ text, origin: 'communication', kind: 'session-direct' }], initialMessageId: 'delegation' });
    settle('delegation', 'accepted');
    expect(readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant' }).entries.map(entry => entry.id)).toEqual(['delegation']);
  });

  it('reports missing sessions and invalid cursors instead of an empty successful history', () => {
    expect(() => readTaskExchanges({ conversationId: 'gone', fromSessionId: 'assistant' })).toThrow('missing');
    expect(() => readTaskExchanges({ conversationId: 'task', fromSessionId: 'assistant', after: -1 })).toThrow('cursor');
  });
});
