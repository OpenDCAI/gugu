import { describe, expect, it, vi } from 'vitest';
import { fitsTimelineArchiveBudget, TIMELINE_ARCHIVE_MAX_ENTRIES } from './archive-budget';
import type { RecordEntry, SessionRecordSource } from './contract';
import { createSessionTimeline } from './timeline';

describe('bounded archive admission', () => {
  it('bounds escaped and non-ASCII strings without encoding them', () => {
    expect(fitsTimelineArchiveBudget({ text: '\u0000😀你好' })).toBe(true);
    expect(fitsTimelineArchiveBudget({ text: '\u0000'.repeat(20_000) })).toBe(false);
  });

  it('counts shared references for every serialized occurrence', () => {
    const shared = { text: 'x'.repeat(6_000) };
    expect(fitsTimelineArchiveBudget([shared, shared])).toBe(false);
  });

  it('rejects cycles, excessive depth, getters and custom serializers', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(fitsTimelineArchiveBudget(cycle)).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(fitsTimelineArchiveBudget(deep)).toBe(false);
    const get = vi.fn(() => 'not called');
    const object = Object.defineProperty({}, 'text', { enumerable: true, get });
    expect(fitsTimelineArchiveBudget(object)).toBe(false);
    expect(get).not.toHaveBeenCalled();
    const toJSON = vi.fn();
    expect(fitsTimelineArchiveBudget({ toJSON })).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each(['many', 'large-text'] as const)('rejects %s before resume/export and rebuilds on next use', async (kind) => {
    const entries: RecordEntry[] = kind === 'many'
      ? Array.from({ length: TIMELINE_ARCHIVE_MAX_ENTRIES + 1 }, (_, i) => ({ key: `end-${i}`, boundary: { kind: 'turn_end' } }))
      : [{ key: 'text', at: 100, event: { kind: 'message', messageId: 'message', role: 'user', text: 'x'.repeat(20_000) } }];
    const resume = vi.fn(async () => ({ data: null, fingerprint: 'same-file' }));
    const start = vi.fn<SessionRecordSource['start']>(async (events) => { events.onEntries(entries); });
    const source = (): SessionRecordSource => ({
      locator: { harness: 'codex', providerSessionId: 'budget', roots: [] },
      start, stop: () => {}, resumePoint: resume,
    });
    const first = await createSessionTimeline(source(), { sessionId: 'budget' });
    try {
      const snapshot = first.getSnapshot().turns;
      const encode = vi.spyOn(JSON, 'stringify');
      expect(await first.archive!()).toBeNull();
      expect(resume).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
      encode.mockRestore();
      first.dispose();
      const next = await createSessionTimeline(source(), { sessionId: 'budget' });
      try {
        expect(start).toHaveBeenCalledTimes(2);
        expect(next.epoch).not.toBe(first.epoch);
        expect(next.getSnapshot().turns).toEqual(snapshot);
      } finally { next.dispose(); }
    } finally { first.dispose(); vi.restoreAllMocks(); }
  });

  it('profiles the bounded admission cases when requested', () => {
    if (!process.env.GUGU_ARCHIVE_BUDGET_PROFILE) return;
    const cases = [
      { name: 'near-node-limit', value: Array.from({ length: 250 }, () => ({ id: 'one', seq: 1 })) },
      { name: 'near-byte-limit', value: { text: 'x'.repeat(10_000) } },
      { name: '298M-character-string', value: { text: 'x'.repeat(298_088_845) } },
      { name: 'million-entries', value: new Array(1_000_000) },
    ];
    for (const probe of cases) {
      let maxMs = 0;
      for (let i = 0; i < 100; i++) {
        const started = performance.now();
        fitsTimelineArchiveBudget(probe.value);
        maxMs = Math.max(maxMs, performance.now() - started);
      }
      console.info(`archive-admission ${probe.name}: max ${maxMs.toFixed(3)} ms (100 calls)`);
      expect(maxMs).toBeLessThan(5);
    }
  });
});
