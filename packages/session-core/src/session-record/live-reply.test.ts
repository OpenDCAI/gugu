import { describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { createSessionTimeline } from './timeline';
import { liveReplyOf } from './live-reply';
import type { TimelineAfterResult } from './contract';

function turn(route = 'chat', message = 'msg:one'): TranscriptTurn {
  return { id: 'turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: `<gugu_delivery route="${route}" from="Owner" from_id="user:owner" msg="${message}" chat="dm"><![CDATA[Hi]]></gugu_delivery>` },
    { kind: 'thinking', id: 'thought', seq: 1, segmentId: 'segment', text: 'Checking the request', status: 'thinking', startedAt: 1_000 },
  ] };
}

describe('source-bound live reply', () => {
  it('coalesces text bursts but publishes the first thought and its end immediately', async () => {
    vi.useFakeTimers();
    const source = { locator: { harness: 'claude' as const, providerSessionId: 'provider', roots: [] }, start: async () => {}, stop: () => {}, resumePoint: async () => ({ fingerprint: 'same-source', data: {} }) };
    const timeline = await createSessionTimeline(source, { sessionId: 'test-rate' });
    try {
      const received: TimelineAfterResult[] = [];
      timeline.subscribe(timeline.getSnapshot().cursor, batch => received.push(batch));
      const active = turn();
      timeline.syncLiveReply(liveReplyOf(active));
      expect(received).toHaveLength(1);
      const thought = active.items.at(-1)!;
      if (thought.kind !== 'thinking') throw new Error('fixture');
      for (let n = 0; n < 1_000; n++) { thought.text = `fragment ${n}`; timeline.syncLiveReply(liveReplyOf(active)); }
      expect(received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(received).toHaveLength(2);
      expect(received.at(-1)).toMatchObject({ ok: true, batch: { liveReply: { activity: { text: 'fragment 999' } } } });
      thought.text = 'last fragment'; timeline.syncLiveReply(liveReplyOf(active));
      timeline.syncLiveReply(null);
      expect(received).toHaveLength(3);
      expect(received.at(-1)).toMatchObject({ ok: true, batch: { liveReply: null } });
      await vi.advanceTimersByTimeAsync(100);
      expect(received).toHaveLength(3);
    } finally { timeline.dispose(); vi.useRealTimers(); }
  });

  it('reports an actual thinking block and its authentic start, then follows text and tools', () => {
    const active = turn();
    expect(liveReplyOf(active)).toEqual({ sourceMessageId: 'msg:one', activity: { phase: 'thinking', id: 'thought', startedAt: 1_000, text: 'Checking the request' } });
    active.items.push({ kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'Hello' });
    expect(liveReplyOf(active)?.activity).toEqual({ phase: 'replying' });
    active.items.push({ kind: 'execute-tool-call', id: 'tool', seq: 3, toolCallId: 'call', title: 'send', status: 'running', command: 'send' });
    expect(liveReplyOf(active)?.activity).toEqual({ phase: 'tools', count: 1 });
  });

  it('publishes increasing real tool counts without counting nested agent work', async () => {
    const active = turn();
    active.items.push({ kind: 'execute-tool-call', id: 'cmd1', seq: 2, toolCallId: 'call1', title: 'pwd', status: 'running', command: 'pwd' });
    expect(liveReplyOf(active)?.activity).toEqual({ phase: 'tools', count: 1 });
    const source = { locator: { harness: 'claude' as const, providerSessionId: 'provider', roots: [] }, start: async () => {}, stop: () => {}, resumePoint: async () => ({ fingerprint: 'same-source', data: {} }) };
    const timeline = await createSessionTimeline(source, { sessionId: 'test-tool-count' });
    const batches: TimelineAfterResult[] = [];
    timeline.subscribe(timeline.getSnapshot().cursor, batch => batches.push(batch));
    timeline.syncLiveReply(liveReplyOf(active));
    active.items.push({ kind: 'execute-tool-call', id: 'cmd2', seq: 3, toolCallId: 'call2', title: 'node', status: 'running', command: 'node -v' });
    timeline.syncLiveReply(liveReplyOf(active));
    expect(batches.at(-1)).toMatchObject({ ok: true, batch: { liveReply: { activity: { phase: 'tools', count: 2 } } } });
    expect(batches).toHaveLength(2);
    active.items.push({ kind: 'execute-tool-call', id: 'nested', seq: 4, toolCallId: 'sub', parentToolCallId: 'call2', title: 'child', status: 'running', command: 'uname' });
    expect(liveReplyOf(active)?.activity).toEqual({ phase: 'tools', count: 2 });
    timeline.dispose();
  });

  it('never claims a schedule, other route, thread, completed turn or a later unrelated input', () => {
    expect(liveReplyOf(turn('schedule'))).toBeNull();
    expect(liveReplyOf(turn('session-direct'))).toBeNull();
    expect(liveReplyOf({ ...turn(), outcome: { kind: 'done' } })).toBeNull();
    expect(liveReplyOf({ ...turn(), endedAt: 2_000 })).toBeNull();
    const active = turn();
    const input = active.items[0];
    if (input.kind === 'message') input.text = input.text.replace(' chat=', ' thread="thread-1" chat=');
    expect(liveReplyOf(active)).toBeNull();
    active.items.push({ kind: 'message', id: 'other', seq: 2, role: 'user', text: 'manual prompt' });
    expect(liveReplyOf(active)).toBeNull();
  });

  it('publishes before any record is written, clears explicitly, and does not restore live state from archives', async () => {
    const source = { locator: { harness: 'claude' as const, providerSessionId: 'provider', roots: [] }, start: async () => {}, stop: () => {}, resumePoint: async () => ({ fingerprint: 'same-source', data: {} }) };
    const timeline = await createSessionTimeline(source, { sessionId: 'test-live' });
    const before = timeline.getSnapshot();
    const received: TimelineAfterResult[] = [];
    const stop = timeline.subscribe(before.cursor, (batch) => received.push(batch));
    const reply = liveReplyOf(turn());
    timeline.syncLiveReply(reply);
    expect(timeline.getSnapshot().turns).toEqual([]);
    expect(received.at(-1)).toMatchObject({ ok: true, batch: { liveReply: reply } });
    const cursor = timeline.getSnapshot().cursor;
    timeline.syncLiveReply(reply);
    expect(timeline.getSnapshot().cursor).toEqual(cursor);
    const archive = await timeline.archive?.();
    expect(archive).toBeTruthy();
    const restored = await createSessionTimeline(source, { sessionId: 'test-live', archive });
    expect(restored.getSnapshot().liveReply).toBeNull();
    restored.dispose();
    timeline.syncLiveReply(null);
    expect(received.at(-1)).toMatchObject({ ok: true, batch: { liveReply: null } });
    expect(timeline.getSnapshot().cursor.seq).toBeGreaterThan(cursor.seq);
    stop(); timeline.dispose();
  });
});
