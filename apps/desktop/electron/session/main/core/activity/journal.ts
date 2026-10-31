import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { activityEventSchema, activityObservationSchema, activityQuerySchema, type ActivityEvent, type ActivityObservation,
  type ActivityQuery } from '@shared/core/activity';
import { withoutSleep, type ConfirmedSleep } from './confirmed-sleep';
import { taskName } from '../sessions/task-name';

type Row = { seq: number; data: string };
type Coverage = { started_at: number; last_seen_at: number; ended_at: number | null };
const HEARTBEAT_GAP_MS = 180_000;

/** Append-only temporal metadata. It has no dependency on any transcript/preview reader. */
export class ActivityJournal {
  private segmentId: string | null = null;
  private fault = false;
  constructor(private readonly sql: Database.Database, private readonly now: () => number = Date.now) {}

  start(): void {
    const now = this.now();
    this.segmentId = randomUUID();
    // A killed process can only attest through its last heartbeat.
    this.sql.prepare('UPDATE activity_coverage SET ended_at = last_seen_at WHERE ended_at IS NULL').run();
    this.sql.prepare('INSERT INTO activity_coverage (id, started_at, last_seen_at) VALUES (?, ?, ?)').run(this.segmentId, now, now);
  }
  heartbeat(): void {
    if (this.fault) return;
    if (!this.segmentId) throw new Error('Activity collector has not started');
    const last = this.sql.prepare('SELECT last_seen_at FROM activity_coverage WHERE id = ?').get(this.segmentId) as { last_seen_at: number };
    if (this.now() - last.last_seen_at > HEARTBEAT_GAP_MS) {
      this.stop(last.last_seen_at);
      this.start();
    } else {
      this.sql.prepare('UPDATE activity_coverage SET last_seen_at = ? WHERE id = ?').run(this.now(), this.segmentId);
    }
  }
  stop(at = this.now()): void {
    if (!this.segmentId) return;
    this.sql.prepare('UPDATE activity_coverage SET ended_at = CASE WHEN ? THEN last_seen_at ELSE ? END, last_seen_at = CASE WHEN ? THEN last_seen_at ELSE ? END WHERE id = ?').run(this.fault ? 1 : 0, at, this.fault ? 1 : 0, at, this.segmentId);
    this.segmentId = null;
  }
  failed(): void { this.fault = true; }

  append(input: ActivityObservation): void {
    const observed = activityObservationSchema.parse(input);
    const projectId = this.projectOf(observed);
    const event: ActivityEvent = projectId === null ? observed : { ...observed, project_id: projectId };
    this.sql.prepare(`INSERT INTO activity_events (event_id, occurred_at, observed_at, kind, session_id, project_id, data)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).run(event.event_id, event.occurred_at,
      event.observed_at, event.kind, event.session_id ?? null, projectId, JSON.stringify(event));
  }
  /**
   * The project an event belongs to, derived here from its subject; producers cannot supply it. A session's project
   * never changes (no path moves a session to another project; deleting a project deletes its sessions), so the
   * record the database writes with every session row (activity_session_projects, migration 0039) gives the same
   * answer before and after the session is deleted. An automation run belongs to its automation's project at the
   * time of the run. A subject this machine never had belongs to no project.
   */
  private projectOf(event: ActivityObservation): string | null {
    if (event.kind.startsWith('project.')) return event.object_id ?? null;
    if (event.session_id !== undefined) {
      const row = this.sql.prepare('SELECT project_id FROM activity_session_projects WHERE session_id = ?')
        .get(event.session_id) as { project_id: string } | undefined;
      return row ? row.project_id : null;
    }
    if (event.kind === 'automation.run' && event.object_id !== undefined) {
      const row = this.sql.prepare(`SELECT automations.project_id FROM automation_runs
        JOIN automations ON automations.id = automation_runs.automation_id WHERE automation_runs.id = ?`)
        .get(event.object_id) as { project_id: string | null } | undefined;
      return row ? row.project_id : null;
    }
    return null;
  }
  /**
   * Whether a later revert in the same session removed the stored turn this event names. Stored sequences are taken
   * again after a revert, so the event's turn_seq names its turn only until then; both facts come from the stored
   * history writer and are ordered by this journal.
   */
  turnRevertedAfter(eventId: string): boolean {
    return this.sql.prepare(`SELECT 1 FROM activity_events turn JOIN activity_events revert
      ON revert.session_id = turn.session_id AND revert.seq > turn.seq AND revert.kind = 'session.history_reverted'
      WHERE turn.event_id = ? AND json_extract(revert.data, '$.turn_seq') <= json_extract(turn.data, '$.turn_seq')
      LIMIT 1`).get(eventId) !== undefined;
  }
  get(eventId: string): ActivityEvent {
    const row = this.sql.prepare('SELECT data FROM activity_events WHERE event_id = ?').get(eventId) as { data: string } | undefined;
    if (!row) throw new Error('Activity event does not exist on this machine');
    return activityEventSchema.parse(JSON.parse(row.data));
  }
  list(input: ActivityQuery) {
    if (this.fault) throw new Error('Activity capture failed in this process; coverage is incomplete. Check the host log.');
    const q = activityQuerySchema.parse(input);
    const identity = this.sql.prepare('SELECT id FROM activity_coverage ORDER BY rowid LIMIT 1').get() as { id: string } | undefined;
    const signature = createHash('sha256').update(JSON.stringify([identity?.id, q.since, q.until, q.session_id ?? null, q.project_id ?? null])).digest('hex');
    let after = 0;
    let high = (this.sql.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM activity_events').get() as { n: number }).n;
    if (q.cursor) {
      let c: { v: number; signature: string; after: number; high: number };
      try { c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()); } catch { throw new Error('Invalid activity cursor'); }
      if (!c || c.v !== 1 || c.signature !== signature || !Number.isSafeInteger(c.after) || !Number.isSafeInteger(c.high)
        || c.after < 0 || c.high < c.after || c.high > high) throw new Error('Activity cursor does not match this query or journal');
      after = c.after;
      high = c.high;
    }
    // Unknown event time is queried by observation time, and remains null in the answer.
    const conditions = ['seq > ?', 'seq <= ?', 'COALESCE(occurred_at, observed_at) >= ?', 'COALESCE(occurred_at, observed_at) < ?'];
    const args: (string | number)[] = [after, high, Date.parse(q.since), Date.parse(q.until)];
    for (const field of ['session_id', 'project_id'] as const) if (q[field]) { conditions.push(`${field} = ?`); args.push(q[field]); }
    const rows = this.sql.prepare(`SELECT seq, data FROM activity_events WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, q.limit + 1) as Row[];
    const page = rows.slice(0, q.limit);
    // Current session metadata, not input/reply text and not an event-time title.
    const sessionIds = [...new Set(page.flatMap(row => {
      const event = activityEventSchema.parse(JSON.parse(row.data));
      return event.session_id ? [event.session_id] : [];
    }))];
    // A session's one name (task-name.ts): its pending-bind record is the only stored copy.
    const named = sessionIds.length === 0 ? [] : this.sql.prepare(
      `SELECT id, json_extract(config, '$.agentDisplayName') AS agentDisplayName FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`
    ).all(...sessionIds) as Array<{ id: string; agentDisplayName: string | null }>;
    const segments = this.sql.prepare(`SELECT started_at, last_seen_at, ended_at FROM activity_coverage
      WHERE started_at < ? AND COALESCE(ended_at, last_seen_at) >= ? ORDER BY started_at`).all(Date.parse(q.until), Date.parse(q.since)) as Coverage[];
    // Sleep can start before this query window and has no session/project. Read
    // overlapping attestations independently of event pagination and filters.
    const sleepRows = this.sql.prepare(`SELECT data FROM activity_events WHERE kind = 'device.sleep'
      AND seq <= ? AND occurred_at < ? AND json_extract(data, '$.sleep_until_at') > ?`)
      .all(high, Date.parse(q.until), Date.parse(q.since)) as Array<{ data: string }>;
    const sleeps: ConfirmedSleep[] = sleepRows.map(row => activityObservationSchema.parse(JSON.parse(row.data)))
      .map(event => ({ since: event.occurred_at!, until: event.sleep_until_at!, source: event.sleep_source! }));
    return {
      events: page.map(row => ({ ...activityEventSchema.parse(JSON.parse(row.data)), sequence: row.seq })),
      session_titles: Object.fromEntries(named.map(row => [row.id, taskName({ id: row.id, config: { agentDisplayName: row.agentDisplayName ?? undefined } })])),
      next_cursor: rows.length > q.limit ? Buffer.from(JSON.stringify({ v: 1, signature, after: page.at(-1)!.seq, high })).toString('base64url') : null,
      order: 'observation_sequence',
      coverage: { scope: 'this_machine', queried_at: this.now(), collector_running: this.segmentId !== null,
        segments: withoutSleep(segments, sleeps), sleep_intervals: sleeps,
        untracked: ['terminal_input_submission', 'external_cli_without_adapter', 'foreground_dwell', 'device_call_history',
          'app_source_edits_without_host_operation', 'model_changes_without_runtime_confirmation'],
        note: 'Only the recorded segments are covered; earlier history and gaps are unknown. Terminal bytes are not interpreted as input submissions. Agent done is a turn ending, not task acceptance.' },
    };
  }
}
