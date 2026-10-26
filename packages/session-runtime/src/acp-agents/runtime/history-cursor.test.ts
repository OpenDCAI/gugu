import { describe, expect, it } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

async function started() {
  const h = makeAcpHarness();
  const rt = new AcpRuntime(h.deps);
  expect((await rt.startSession(makeStartInput({ sessionId: 'history' }))).success).toBe(true);
  return { rt, h };
}

describe('ACP history change cursor', () => {
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
