import { describe, expect, it, vi } from 'vitest';
import { fitsTimelineArchiveSourceBudget, TIMELINE_ARCHIVE_MAX_SOURCE_BYTES } from './archive-budget';
import type { RecordEntry, SessionRecordSource } from './contract';
import { createSessionTimeline } from './timeline';

describe('consumed transcript archive admission', () => {
  it('admits exactly the measured source cap and rejects larger or unknown source sizes in constant work', () => {
    for (const bytes of [0, 2 * 1024 * 1024, 7 * 1024 * 1024, TIMELINE_ARCHIVE_MAX_SOURCE_BYTES]) {
      expect(fitsTimelineArchiveSourceBudget(bytes)).toBe(true);
    }
    for (const bytes of [TIMELINE_ARCHIVE_MAX_SOURCE_BYTES + 1, 600 * 1024 * 1024, NaN, Infinity, -1, 0.5]) {
      expect(fitsTimelineArchiveSourceBudget(bytes)).toBe(false);
    }
  });

  it.each([2, 7, 7.5])('archives a %s MiB-source timeline with over 1,024 entries and resumes it', async (mib) => {
    const entries: RecordEntry[] = Array.from({ length: 2048 }, (_, i) => ({ key: `end-${i}`, boundary: { kind: 'turn_end' } }));
    entries.push({ key: 'text', event: { kind: 'message', messageId: 'message', role: 'user', text: 'x'.repeat(128 * 1024) } });
    const start = vi.fn<SessionRecordSource['start']>(async (events, resume) => { if (!resume) events.onEntries(entries); });
    const source = (): SessionRecordSource => ({
      locator: { harness: 'codex', providerSessionId: 'budget', roots: [] },
      start, stop: () => {},
      resumePoint: async (budget) => {
        if (budget && (budget.remainingBytes -= mib * 1024 * 1024) < 0) return null;
        return { data: null, fingerprint: 'same-file' };
      },
    });
    const first = await createSessionTimeline(source(), { sessionId: 'budget' });
    try {
      const snapshot = first.getSnapshot().turns;
      const archive = await first.archive!();
      expect(archive?.sourceBytes).toBe(mib * 1024 * 1024);
      expect(archive?.seenKeys).toHaveLength(2049);
      first.dispose();
      const next = await createSessionTimeline(source(), { sessionId: 'budget', archive });
      try {
        expect(start.mock.calls[1][1]).toEqual(archive!.resume);
        expect(next.epoch).not.toBe(first.epoch);
        expect(next.getSnapshot().turns).toEqual(snapshot);
      } finally { next.dispose(); }
    } finally { first.dispose(); }
  });
});
