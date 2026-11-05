import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { noopLogger } from '@gugu/session-shared/logger';
import { FakeAcpAgent, requestActivityCell } from '../../../../../../../packages/session-runtime/src/acp-agents/acp-test-support';

const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
const { nativeConversationUnread, noteNativeConversationReplies, markNativeConversationVisible, truncateNativeConversationRead } = await import('./session-conversation-read');
const { nativeConversationActivity } = await import('./session-conversation-activity');
let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture(); mock.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id) VALUES('s','p')");
});
afterEach(() => { fixture.close(); mock.db = undefined; });
const turn = (ids: string[]): TranscriptTurn => ({ id: 's:turn:1', seq: 1, initiator: 'user', items: ids.map((id, seq) => ({ kind: 'message', id: `s:turn:1:message:${id}`, seq, role: 'assistant', text: 'reply' })) });

describe('native personal conversation unread', () => {
  it('projects an owner reply steered into the real runtime while its original turn remains delivery-started', async () => {
    const delivered = '<gugu_delivery route="chat" chat="group" chat_kind="group" msg="msg:group"><![CDATA[Group input]]></gugu_delivery>';
    const agent = new FakeAcpAgent();
    let finish!: () => void;
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(resolve => { finish = () => resolve({ stopReason: 'end_turn' }); }));
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
    const cell = requestActivityCell(agent, { sessionId: 's', projectId: 'p', providerId: 'claude', acpSessionId: 'native', supportsSteering: true, resolveAttachment: vi.fn(), logger: noopLogger });
    cell.applySessionReady();
    const running = cell.prompt({ text: delivered, origin: 'communication' });
    await agent.called('prompt');
    cell.push({ kind: 'message', role: 'assistant', messageId: 'group-reply', text: 'Group reply' });
    expect(await cell.queueBehindTurn({ text: 'Owner follow-up', origin: 'manual' })).toMatchObject({ success: true, data: { queued: false } });
    cell.push({ kind: 'message', role: 'assistant', messageId: 'owner-reply', text: 'New owner reply' });
    finish(); await running;
    const record = cell.history().committed[0]!;
    expect(record.trigger).toMatchObject({ kind: 'delivery' });
    noteNativeConversationReplies('s', record)?.();
    expect(nativeConversationActivity('s')?.text).toBe('New owner reply');
    expect(nativeConversationUnread('s')).toEqual([record.items.find(item => item.kind === 'message' && item.text === 'New owner reply')!.id]);
  });

  it.each(['agent', 'schedule', 'delivery'] as const)('does not turn %s background work into owner conversation activity', kind => {
    const record: TranscriptTurn = { id: 's:turn:s1', seq: 1, initiator: kind === 'agent' ? 'agent' : 'user', trigger: { kind }, startedAt: 1000, endedAt: 2000, items: [
      { kind: 'message', id: 'background-input', seq: 0, role: 'user', text: 'Background task notification', at: 1000 },
      { kind: 'message', id: 'background-answer', seq: 1, role: 'assistant', text: 'Finished background work', at: 2000 },
    ] };
    noteNativeConversationReplies('s', record);
    expect(nativeConversationActivity('s')).toBeNull();
    expect(nativeConversationUnread('s')).toEqual([]);
  });

  it('ends an owner segment at a later non-owner input without clearing the earlier reply', () => {
    const record: TranscriptTurn = { id: 'mixed', seq: 4, initiator: 'user', trigger: { kind: 'delivery' }, startedAt: 1000, endedAt: 5000, items: [
      { kind: 'message', id: 'delegation', seq: 0, role: 'user', text: 'A raw delegated task', at: 1000 },
      { kind: 'message', id: 'background', seq: 1, role: 'assistant', text: 'Background reply', at: 2000 },
      { kind: 'message', id: 'owner', seq: 2, role: 'user', text: 'Owner input', at: 3000, _meta: { guguOwnerInput: true } },
      { kind: 'message', id: 'personal', seq: 3, role: 'assistant', text: 'Personal reply', at: 3500 },
      { kind: 'message', id: 'later', seq: 4, role: 'user', text: 'Another raw delegation', at: 4000, _meta: { guguOwnerInput: false } },
      { kind: 'message', id: 'later-reply', seq: 5, role: 'assistant', text: 'Later background reply', at: 5000 },
    ] };
    noteNativeConversationReplies('s', record)?.();
    expect(nativeConversationActivity('s')).toEqual({ text: 'Personal reply', at: new Date(3500).toISOString(), turnSeq: 4 });
    expect(nativeConversationUnread('s')).toEqual(['personal']);
  });

  it('keeps explicit owner notifications visible during a background turn without taking unrelated text', () => {
    const record: TranscriptTurn = { id: 'background', seq: 5, initiator: 'agent', trigger: { kind: 'agent' }, items: [
      { kind: 'message', id: 'notice', seq: 0, role: 'assistant', text: 'A deliberate notice', at: 2000,
        ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash' } },
      { kind: 'message', id: 'unrelated', seq: 1, role: 'assistant', text: 'Private background work', at: 3000 },
    ] };
    noteNativeConversationReplies('s', record)?.();
    expect(nativeConversationActivity('s')?.text).toBe('A deliberate notice');
    expect(nativeConversationUnread('s')).toEqual(['notice']);
  });

  it('publishes the actual native reply and its original time without inventing another IM message', () => {
    const at = Date.parse('2026-10-29T11:00:00Z');
    const record: TranscriptTurn = { id: 's:turn:s1', seq: 1, initiator: 'user', startedAt: at, endedAt: at + 2000, items: [
      { kind: 'message', id: 'user', seq: 0, role: 'user', text: 'Native input', at },
      { kind: 'message', id: 'reply', seq: 1, role: 'assistant', text: 'Native answer', at: at + 1000 },
    ] };
    noteNativeConversationReplies('s', record);
    expect(nativeConversationActivity('s')).toEqual({ text: 'Native answer', at: new Date(at + 1000).toISOString(), turnSeq: 1 });
    noteNativeConversationReplies('s', { ...record, seq: 0, items: [{ kind: 'message', id: 'old', seq: 0, role: 'user', text: 'Older input', at: at - 1000 }] });
    expect(nativeConversationActivity('s')?.text).toBe('Native answer');
    truncateNativeConversationRead('s', 2)?.();
    expect(nativeConversationActivity('s')?.text).toBe('Native answer');
    truncateNativeConversationRead('s', 1)?.();
    expect(nativeConversationActivity('s')).toBeNull();
  });
  it('does not project delivery envelopes, local attachment instructions or unknown replay clocks as native previews', () => {
    const at = 1000;
    for (const text of ['<gugu_delivery route="chat" chat="group" chat_kind="group" msg="msg:group"><![CDATA[Group input]]></gugu_delivery>', '[Image attached at local path: /private/photo.png]']) {
      noteNativeConversationReplies('s', { id: 't', seq: 0, initiator: 'user', startedAt: at, items: [{ kind: 'message', id: 'u', seq: 0, role: 'user', text }] });
    }
    noteNativeConversationReplies('s', turn(['old']));
    expect(nativeConversationActivity('s')).toBeNull();
  });
  it('only reads visible replies, across the phone and desktop turn prefixes', () => {
    noteNativeConversationReplies('s', turn(['msg_first', 'msg_covered']));
    expect(nativeConversationUnread('s')).toEqual(['s:turn:1:message:msg_first', 's:turn:1:message:msg_covered']);
    markNativeConversationVisible('s', ['s:turn:s12:message:msg_first']);
    expect(nativeConversationUnread('s')).toEqual(['s:turn:1:message:msg_covered']);
    markNativeConversationVisible('s', ['unknown']);
    expect(nativeConversationUnread('s')).toEqual(['s:turn:1:message:msg_covered']);
  });
  it('does not confuse a reused synthetic live id after the runtime restarts', () => {
    const live = turn(['auto:assistant:0']);
    const a = { ...live, id: 's:turn:s1', items: live.items.map(item => ({ ...item, id: 's:turn:s1:message:auto:assistant:0' })) };
    const b = { ...live, id: 's:turn:s2', items: live.items.map(item => ({ ...item, id: 's:turn:s2:message:auto:assistant:0' })) };
    noteNativeConversationReplies('s', a, live);
    noteNativeConversationReplies('s', b, live);
    markNativeConversationVisible('s', [live.items[0]!.id]);
    expect(nativeConversationUnread('s')).toHaveLength(2);
    markNativeConversationVisible('s', [b.items[0]!.id]);
    expect(nativeConversationUnread('s')).toEqual([a.items[0]!.id]);
  });
  it('keeps group delivery reads separate when a raw personal input follows in the same turn', () => {
    const delivered = '<gugu_delivery route="chat" chat="group" chat_kind="group" msg="msg:group"><![CDATA[Group input]]></gugu_delivery>';
    const mixed: TranscriptTurn = { id: 's:turn:s1', seq: 1, initiator: 'user', items: [
      { kind: 'message', id: 's:turn:s1:message:group-user', seq: 0, role: 'user', text: delivered },
      { kind: 'message', id: 's:turn:s1:message:group-reply', seq: 1, role: 'assistant', text: 'group answer' },
      { kind: 'message', id: 's:turn:s1:message:own-user', seq: 2, role: 'user', text: 'personal input' },
      { kind: 'message', id: 's:turn:s1:message:own-reply', seq: 3, role: 'assistant', text: 'personal answer' },
    ] };
    noteNativeConversationReplies('s', mixed);
    expect(nativeConversationUnread('s')).toEqual(['s:turn:s1:message:own-reply']);
  });
  it('keeps confirmed reads after a repeated native event and a module restart', async () => {
    const reply = turn(['msg_first']);
    noteNativeConversationReplies('s', reply);
    markNativeConversationVisible('s', ['s:turn:1:message:msg_first']);
    noteNativeConversationReplies('s', reply);
    vi.resetModules();
    expect((await import('./session-conversation-read')).nativeConversationUnread('s')).toEqual([]);
  });
});
