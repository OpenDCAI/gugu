import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { decodeSessionUpdate, type TranscriptTurn } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { makeAcpHarness, makeStartInput } from '../../../../../../../packages/session-runtime/src/acp-agents/acp-test-support';
import { AcpRuntime } from '../../../../../../../packages/session-runtime/src/acp-agents/runtime/runtime';

const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { nativeConversationListActivity, openNativeConversationPreviews } from './session-conversation-live';
import { nativeConversationActivity } from './session-conversation-activity';
import { nativeConversationUnread } from './session-conversation-read';
import { appendRecordTurnNow, persistCommittedTurn, reviseRecordTurnNow, withStoredTurns } from './session-turn-store';
import { events } from '@main/lib/events';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture(); mock.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id) VALUES('s','p')");
});
afterEach(() => { openNativeConversationPreviews(async () => {}).dispose(); fixture.close(); mock.db = undefined; vi.restoreAllMocks(); });

const historical = (text: string, at?: number): TranscriptTurn => ({
  id: 'native-record', seq: 0, initiator: 'user', trigger: { kind: 'owner' },
  items: [{ kind: 'message', id: 'answer', seq: 0, role: 'assistant', text, ...(at === undefined ? {} : { at }) }],
});

describe('ordinary personal replies in the native conversation directory', () => {
  it('uses two distinct real runtime replies before completion and hands the same preview/time to durable storage', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = makeAcpHarness();
    const bridge = openNativeConversationPreviews(id => withStoredTurns(id, async () => {}));
    const writes: Promise<unknown>[] = [];
    const rt = new AcpRuntime({ ...h.deps,
      onConversationActivity: event => { writes.push(bridge.update(event)); },
      onTurnCommitted: event => { writes.push(persistCommittedTurn(event)); },
    });
    let finish!: () => void;
    try {
      expect(await rt.startSession(makeStartInput({ sessionId: 's', projectId: 'p' }))).toMatchObject({ success: true });
      h.agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(resolve => { finish = () => resolve({ stopReason: 'end_turn' }); }));
      const running = rt.sendPrompt('s', { text: 'One owner input', origin: 'manual' });
      await h.agent.called('prompt');
      const send = async (messageId: string, text: string) => {
        await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
          sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
        } as SessionUpdate) });
      };
      now = 20_000; await send('first', 'First reply');
      await vi.waitFor(() => expect(nativeConversationListActivity('s')).toEqual({ text: 'First reply', at: new Date(now).toISOString() }));
      now = 30_000; await send('second', 'Last reply');
      await vi.waitFor(() => expect(nativeConversationListActivity('s')).toEqual({ text: 'Last reply', at: new Date(30_000).toISOString() }));
      expect(nativeConversationActivity('s')).toBeNull();
      expect(nativeConversationUnread('s')).toEqual([]);
      const active = rt.sessionLiveModels('s')!.states.activeTurn.snapshot().data!;
      expect(active.items.filter(item => item.kind === 'message' && item.role === 'assistant')).toHaveLength(2);
      // More chunks alter the text, not the message's creation time.
      now = 40_000; await send('second', ' continued');
      await vi.waitFor(() => expect(nativeConversationListActivity('s')?.text).toBe('Last reply continued'));
      expect(nativeConversationListActivity('s')?.at).toBe(new Date(30_000).toISOString());
      finish(); await running;
      await vi.waitFor(() => expect(nativeConversationActivity('s')?.text).toBe('Last reply continued'));
      await Promise.all(writes);
      expect(nativeConversationListActivity('s')).toMatchObject({ text: 'Last reply continued', at: new Date(30_000).toISOString() });
      expect(nativeConversationActivity('s')).toMatchObject({ text: 'Last reply continued', at: new Date(30_000).toISOString() });
      expect(nativeConversationUnread('s')).toHaveLength(2);
      expect(vi.mocked(events.emit).mock.calls.some(([, data]) => (data as { changes?: { nativeLastMessage?: boolean } }).changes?.nativeLastMessage)).toBe(true);
      // A worker restart can discard temporary state without reverting the row to the owner's input.
      bridge.dispose();
      expect(nativeConversationListActivity('s')?.text).toBe('Last reply continued');
    } finally { finish?.(); await rt.dispose(); bridge.dispose(); await Promise.all(writes); }
  });

  it('ignores an old worker and its delayed cleanup after a successor publishes', async () => {
    let settle!: () => void;
    const a = openNativeConversationPreviews(() => new Promise<void>(resolve => { settle = resolve; }));
    await a.update({ sessionId: 's', preview: { text: 'Old worker', at: 1000 } });
    const clearing = a.update({ sessionId: 's', preview: null });
    const b = openNativeConversationPreviews(async () => {});
    await b.update({ sessionId: 's', preview: { text: 'New worker', at: 2000 } });
    settle(); await clearing;
    await a.update({ sessionId: 's', preview: { text: 'Late old event', at: 3000 } });
    a.dispose();
    expect(nativeConversationListActivity('s')?.text).toBe('New worker');
    b.dispose(); expect(nativeConversationListActivity('s')).toBeNull();
  });

  it('does not clear a new turn while the preceding commit settles', async () => {
    let settle!: () => void;
    const bridge = openNativeConversationPreviews(() => new Promise<void>(resolve => { settle = resolve; }));
    await bridge.update({ sessionId: 's', preview: { text: 'Finishing', at: 1000 } });
    const clearing = bridge.update({ sessionId: 's', preview: null });
    expect(nativeConversationListActivity('s')?.text).toBe('Finishing');
    await bridge.update({ sessionId: 's', preview: { text: 'New turn', at: 2000 } });
    settle(); await clearing;
    expect(nativeConversationListActivity('s')?.text).toBe('New turn');
    bridge.dispose();
  });

  it.each(['record', 'replay'] as const)('fills a %s preview with its original clock and no unread or live inbox', async source => {
    const old = historical('Original answer', 1000);
    if (source === 'record') await withStoredTurns('s', () => appendRecordTurnNow('s', old));
    else await persistCommittedTurn({ sessionId: 's', source: 'replay', turn: old });
    expect(nativeConversationListActivity('s')).toMatchObject({ text: 'Original answer', at: new Date(1000).toISOString() });
    expect(nativeConversationUnread('s')).toEqual([]);
    if (source === 'record') {
      await withStoredTurns('s', () => reviseRecordTurnNow('s', 0, historical('Completed native answer', 2000)));
      expect(nativeConversationListActivity('s')?.text).toBe('Completed native answer');
      expect(nativeConversationUnread('s')).toEqual([]);
    }
  });

  it('does not invent a clock for a native record or demote newer live activity on late history', async () => {
    await withStoredTurns('s', () => appendRecordTurnNow('s', historical('Clock unknown')));
    expect(nativeConversationListActivity('s')).toBeNull();
    await persistCommittedTurn({ sessionId: 's', source: 'live', turn: { ...historical('New answer', 5000), id: 'live' } });
    await withStoredTurns('s', () => appendRecordTurnNow('s', historical('Old answer', 1000)));
    expect(nativeConversationListActivity('s')?.text).toBe('New answer');
  });
});
