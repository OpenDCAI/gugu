import { describe, expect, it } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { createAcpProcedures } from '../api/procedures';

async function started() {
  const h = makeAcpHarness();
  const rt = new AcpRuntime(h.deps);
  expect((await rt.startSession(makeStartInput({ sessionId: 'history' }))).success).toBe(true);
  return { rt, h };
}

describe('ACP history change cursor', () => {
  it('resets an oversized reconnect gap instead of sending all missed turns in one delta', async () => {
    const { rt } = await started();
    const api = createAcpProcedures(rt);
    const initial = api.getHistory({ sessionId: 'history', limit: 100 });
    if (!initial.success) throw initial.error;
    await rt.sendPrompt('history', { text: 'a'.repeat(90_000) });
    await rt.sendPrompt('history', { text: 'b'.repeat(90_000) });
    const delta = api.getHistory({ sessionId: 'history', limit: 100, changedSince: initial.data.cursor });
    if (!delta.success) throw delta.error;
    expect(delta.data.reset).toBe(true);
    expect(delta.data.turns).toHaveLength(0);
    expect(delta.data.nextCursor).toBeNull();
    const latest = api.getHistory({ sessionId: 'history', limit: 100 });
    if (!latest.success) throw latest.error;
    expect(latest.data.turns).toHaveLength(1);
    expect(latest.data.nextCursor).not.toBeNull();
    const older = api.getHistory({ sessionId: 'history', limit: 100, before: latest.data.nextCursor! });
    if (!older.success) throw older.error;
    expect(older.data.turns).toHaveLength(1);
    expect(older.data.turns[0]!.id).not.toBe(latest.data.turns[0]!.id);
    await rt.stopSession('history');
  });

  it('returns only newly committed turns and leaves the stored transcript isolated from the reply', async () => {
    const { rt } = await started();
    await rt.sendPrompt('history', { text: 'first' });
    const first = rt.getHistory('history');
    if (!first.success) throw first.error;
    await rt.sendPrompt('history', { text: 'second' });
    const delta = rt.getHistory('history', undefined, 100, first.data.cursor);
    if (!delta.success) throw delta.error;
    expect(delta.data.reset).toBe(false);
    expect(delta.data.turns).toHaveLength(1);
    expect(JSON.stringify(delta.data.turns)).toContain('second');
    expect(JSON.stringify(delta.data.turns)).not.toContain('first');
    delta.data.turns[0]!.items.length = 0;
    const next = rt.getHistory('history');
    if (!next.success) throw next.error;
    expect(next.data.turns.at(-1)!.items.length).toBeGreaterThan(0);
  });

  it('rejects another runtime epoch even when both sequence numbers are equal', async () => {
    const a = await started();
    const b = await started();
    const first = a.rt.getHistory('history');
    const second = b.rt.getHistory('history');
    if (!first.success || !second.success) throw new Error('history unavailable');
    expect(first.data.cursor.seq).toBe(second.data.cursor.seq);
    expect(first.data.cursor.epoch).not.toBe(second.data.cursor.epoch);
    const stale = b.rt.getHistory('history', undefined, 100, first.data.cursor);
    expect(stale).toMatchObject({ success: true, data: { turns: [], reset: true } });
    const future = b.rt.getHistory('history', undefined, 100, { ...second.data.cursor, seq: second.data.cursor.seq + 1 });
    expect(future).toMatchObject({ success: true, data: { turns: [], reset: true } });
  });
});
