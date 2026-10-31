import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';

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
  it.each(['agent', 'schedule', 'delivery'] as const)('does not turn %s background work into owner conversation activity', kind => {
    const record: TranscriptTurn = { id: 's:turn:s1', seq: 1, initiator: kind === 'agent' ? 'agent' : 'user', trigger: { kind }, startedAt: 1000, endedAt: 2000, items: [
      { kind: 'message', id: 'background-input', seq: 0, role: 'user', text: 'Background task notification', at: 1000 },
      { kind: 'message', id: 'background-answer', seq: 1, role: 'assistant', text: 'Finished background work', at: 2000 },
    ] };
    noteNativeConversationReplies('s', record);
    expect(nativeConversationActivity('s')).toBeNull();
    expect(nativeConversationUnread('s')).toEqual([]);
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
