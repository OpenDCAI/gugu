import { describe, expect, it, vi } from 'vitest';
import type { RecordEntry, SessionRecordSource } from '../contract';
import { withSubagentSources } from './subagent-sources';

function source(id: string, bytes: number, entries: RecordEntry[] = []) {
  const resumePoint = vi.fn<NonNullable<SessionRecordSource['resumePoint']>>(async (budget) => {
    if (budget && (--budget.remainingSources < 0 || (budget.remainingBytes -= bytes) < 0)) return null;
    return { data: null, fingerprint: id };
  });
  const value: SessionRecordSource = {
    locator: { harness: 'codex', providerSessionId: id, roots: [] },
    start: async (events) => { events.onEntries(entries); },
    resumePoint, stop: () => {},
  };
  return { value, resumePoint };
}

const launch = (id: string): RecordEntry => ({ key: id, event: {
  kind: 'subagent', toolCallId: id, subagentSessionId: id, status: 'completed',
  title: id, parentToolCallId: null, canCancel: false,
} });

describe('native child archive budget', () => {
  it('shares the total byte budget between parent and children', async () => {
    const root = source('root', 40, [launch('child')]);
    const child = source('child', 60);
    const combined = withSubagentSources(root.value, () => child.value, () => root.value);
    await combined.start({ onEntries: () => {}, onReset: () => {} });
    try {
      const budget = { remainingBytes: 90, remainingSources: 16 };
      expect(await combined.resumePoint!(budget)).toBeNull();
      expect(root.resumePoint).toHaveBeenCalledWith(budget);
      expect(child.resumePoint).toHaveBeenCalledWith(budget);
      expect(budget.remainingBytes).toBe(-10);
    } finally { combined.stop(); }
  });

  it('rejects excessive child fan-out before requesting any cursor copies', async () => {
    const root = source('root', 1, Array.from({ length: 16 }, (_, i) => launch(`child-${i}`)));
    const child = source('child', 1);
    const combined = withSubagentSources(root.value, () => child.value, () => root.value);
    await combined.start({ onEntries: () => {}, onReset: () => {} });
    try {
      expect(await combined.resumePoint!({ remainingBytes: 64 * 1024, remainingSources: 16 })).toBeNull();
      expect(root.resumePoint).not.toHaveBeenCalled();
      expect(child.resumePoint).not.toHaveBeenCalled();
    } finally { combined.stop(); }
  });

  it('does not save a partial child cursor when one child declines admission', async () => {
    const root = source('root', 1, [launch('child')]);
    const child = source('child', 1);
    child.resumePoint.mockResolvedValue(null);
    const combined = withSubagentSources(root.value, () => child.value, () => root.value);
    await combined.start({ onEntries: () => {}, onReset: () => {} });
    try {
      expect(await combined.resumePoint!({ remainingBytes: 64 * 1024, remainingSources: 16 })).toBeNull();
    } finally { combined.stop(); }
  });
});
