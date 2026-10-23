import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityJournal } from './journal';
import { activitySignal } from './signals';
import type { ActivityObservation } from '@shared/core/activity';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let now: number;
let journal: ActivityJournal;
const since = '2026-10-20T00:00:00Z';
const until = '2026-10-22T00:00:00Z';
const event = (id: string, extra: Partial<ActivityObservation> = {}): ActivityObservation => ({
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
  it('derives a project operation from its subject without accepting a producer project override', () => {
    journal.append({ event_id: 'detached-folder', kind: 'project.folder_detached', object_id: 'p-deleted',
      related_object_id: 'folder-gone', occurred_at: now, observed_at: now });
    expect(journal.list({ since, until, project_id: 'p-deleted' }).events).toMatchObject([
      { project_id: 'p-deleted', object_id: 'p-deleted', related_object_id: 'folder-gone' },
    ]);
    expect(() => journal.append({ event_id: 'missing-project', kind: 'project.deleted', occurred_at: now, observed_at: now })).toThrow(/subject project/);
  });
  it('rejects bodies, free-form payloads and non-metadata additions before writing', () => {
    expect(() => journal.append({ ...event('bad'), content: 'secret input' } as ActivityObservation)).toThrow();
    expect(() => journal.append({ ...event('bad'), payload: { text: 'secret output' } } as ActivityObservation)).toThrow();
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
    fixture.sqlite.exec(`INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p1', 'P1', '/p1', 0, 0);
      INSERT INTO sessions (id, project_id, title) VALUES ('s1', 'p1', 'one');
      DELETE FROM sessions;`);
    journal.append(event('start', { occurred_at: Date.parse(since) }));
    journal.append(event('end', { occurred_at: Date.parse(until) }));
    expect(journal.list({ since, until, project_id: 'p1' }).events.map(e => e.event_id)).toEqual(['start']);
    expect(() => journal.list({ since: until, until: since })).toThrow(/until/);
    expect(() => journal.list({ since, until, cursor: 'garbage' })).toThrow(/cursor/);
  });
});

/**
 * The project of an event is derived by the journal from its subject, never reported by a producer: events whose
 * producer did not have the project at hand (archive, delete, questions, deliveries, automation runs) used to be
 * stored without one and vanished from project-scoped queries.
 */
describe('activity journal: the project comes from the subject', () => {
  beforeEach(() => {
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p1', 'P1', '/p1', 0, 0), ('p2', 'P2', '/p2', 0, 0);
      INSERT INTO sessions (id, project_id, title) VALUES ('s1', 'p1', 'one'), ('s2', 'p2', 'two');
      INSERT INTO automations (id, name, project_id, trigger_config, agent_config, enabled, created_at, updated_at)
        VALUES ('a1', 'Daily', 'p2', '{"expr":"0 9 * * *","tz":"UTC"}', '{"prompt":"x","provider":"claude","autoApprove":true}', 1, 0, 0);
      INSERT INTO automation_runs (id, automation_id, status, trigger_kind) VALUES ('r1', 'a1', 'queued', 'cron');
    `);
  });
  const ids = (project: string) => journal.list({ since, until, project_id: project }).events.map(e => e.event_id);
  const about = (id: string, kind: ActivityObservation['kind'], subject: Partial<ActivityObservation> = { session_id: 's1' }): ActivityObservation =>
    ({ event_id: id, kind, occurred_at: now, observed_at: now, ...subject });

  it('places every session event in its session\'s project, including events after the session is deleted', () => {
    journal.append(about('working', 'agent.status', { session_id: 's1', status: 'working' }));
    journal.append(about('asked', 'question.pending', { session_id: 's1', object_id: 'q1' }));
    journal.append(about('delivered', 'session.message_delivered', { session_id: 's1', object_id: 'm1' }));
    journal.append(about('archived', 'session.archived'));
    fixture.sqlite.exec(`DELETE FROM sessions WHERE id = 's1'`);
    journal.append(about('deleted', 'session.deleted'));
    journal.append(about('other', 'session.renamed', { session_id: 's2' }));
    expect(ids('p1')).toEqual(['working', 'asked', 'delivered', 'archived', 'deleted']);
    expect(ids('p2')).toEqual(['other']);
  });

  it('places a session created after the journal started, by any path, in its project', () => {
    // A trigger on sessions records the project. The fixture runs every migration to head, so a later migration that
    // rebuilds the sessions table (and drops its triggers with it) fails here.
    fixture.sqlite.exec(`INSERT INTO sessions (id, project_id, title) VALUES ('s3', 'p2', 'forked outside the app')`);
    journal.append(about('late', 'session.renamed', { session_id: 's3' }));
    expect(ids('p2')).toEqual(['late']);
  });

  it('places an automation run in its automation\'s project at the time of the run', () => {
    journal.append(about('automation.run:r1:queued', 'automation.run', { object_id: 'r1', status: 'queued' }));
    expect(ids('p2')).toEqual(['automation.run:r1:queued']);
    expect(journal.get('automation.run:r1:queued').project_id).toBe('p2');
  });

  it('leaves a subject this machine never had without a project', () => {
    journal.append(about('unknown', 'session.renamed', { session_id: 'elsewhere' }));
    expect(journal.get('unknown').project_id).toBeUndefined();
  });

  it('refuses a project named by a producer', () => {
    // At run time: the journal's observation schema is strict.
    expect(() => journal.append({ ...about('named', 'session.renamed'), project_id: 'p2' } as ActivityObservation)).toThrow();
    // At compile time: the typecheck fails if a signal may carry project_id (an unused @ts-expect-error is an error).
    // At run time the call reaches no journal: this test installs no signal listener.
    // @ts-expect-error producers cannot name a project
    activitySignal({ event_id: 'typed', kind: 'session.renamed', occurred_at: now, session_id: 's1', project_id: 'p2' });
    expect(ids('p2')).toEqual([]);
  });
});
