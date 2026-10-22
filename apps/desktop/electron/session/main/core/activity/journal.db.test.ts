import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityJournal } from './journal';
import type { ActivityEvent } from '@shared/core/activity';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let now: number;
let journal: ActivityJournal;
const since = '2026-10-20T00:00:00Z';
const until = '2026-10-22T00:00:00Z';
const event = (id: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  event_id: id, kind: 'agent.status', occurred_at: now, observed_at: now, session_id: 's1', status: 'working', ...extra,
});
beforeEach(async () => {
  fixture = await openFixture('empty');
  now = Date.parse('2026-10-21T00:00:00Z');
  journal = new ActivityJournal(fixture.sqlite, () => now);
  journal.start();
});
afterEach(() => { fixture?.close(); });

describe('activity journal: real SQLite, no transcript storage or reader', () => {
  it('deduplicates receipts across restarts and preserves nullable source time', () => {
    journal.append(event('receipt', { occurred_at: null }));
    journal.append(event('receipt'));
    const restarted = new ActivityJournal(fixture.sqlite, () => now + 60_000);
    restarted.start();
    restarted.append(event('receipt'));
    expect(restarted.list({ since, until }).events).toMatchObject([{ event_id: 'receipt', occurred_at: null }]);
    expect(restarted.list({ since, until }).events).toHaveLength(1);
  });
  it('rejects bodies, free-form payloads and non-metadata additions before writing', () => {
    expect(() => journal.append({ ...event('bad'), content: 'secret input' } as ActivityEvent)).toThrow();
    expect(() => journal.append({ ...event('bad'), payload: { text: 'secret output' } } as ActivityEvent)).toThrow();
    expect(() => journal.append(event('bad-ref', { source_ref: 'secret user request' }))).toThrow();
    expect(journal.list({ since, until }).events).toEqual([]);
  });
  it('pages a fixed high watermark, retains late arrivals for the next query, and binds filters', () => {
    journal.append(event('a')); journal.append(event('b')); journal.append(event('c', { session_id: 's2' }));
    const first = journal.list({ since, until, limit: 1, session_id: 's1' });
    journal.append(event('late', { occurred_at: now - 5_000 }));
    const second = journal.list({ since, until, limit: 1, session_id: 's1', cursor: first.next_cursor! });
    expect(first.events.map(e => e.event_id)).toEqual(['a']);
    expect(second.events.map(e => e.event_id)).toEqual(['b']);
    expect(second.next_cursor).toBeNull();
    expect(journal.list({ since, until, session_id: 's1' }).events.map(e => e.event_id)).toEqual(['a', 'b', 'late']);
    expect(() => journal.list({ since, until, session_id: 's2', cursor: first.next_cursor! })).toThrow(/cursor/);
  });
  it('shows restart and suspended-process gaps instead of claiming coverage throughout', () => {
    now += 60_000; journal.heartbeat();
    const lastConfirmed = now;
    now += 600_000; journal.heartbeat();
    const result = journal.list({ since, until });
    expect(result.events).toEqual([]);
    expect(result.coverage.segments).toEqual([
      { started_at: Date.parse('2026-10-21T00:00:00Z'), last_seen_at: lastConfirmed, ended_at: lastConfirmed },
      { started_at: now, last_seen_at: now, ended_at: null },
    ]);
    journal.failed();
    expect(() => journal.list({ since, until })).toThrow(/capture failed/);
  });
  it('does not depend on session or message rows remaining present, and enforces half-open time windows', () => {
    journal.append(event('start', { occurred_at: Date.parse(since), project_id: 'p1' }));
    journal.append(event('end', { occurred_at: Date.parse(until), project_id: 'p1' }));
    expect(journal.list({ since, until, project_id: 'p1' }).events.map(e => e.event_id)).toEqual(['start']);
    expect(() => journal.list({ since: until, until: since })).toThrow(/until/);
    expect(() => journal.list({ since, until, cursor: 'garbage' })).toThrow(/cursor/);
  });
});
