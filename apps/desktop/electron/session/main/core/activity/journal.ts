import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { activityEventSchema, activityQuerySchema, type ActivityEvent, type ActivityQuery } from '@shared/core/activity';

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

  append(input: ActivityEvent): void {
    const event = activityEventSchema.parse(input);
    this.sql.prepare(`INSERT INTO activity_events (event_id, occurred_at, observed_at, kind, session_id, project_id, data)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).run(event.event_id, event.occurred_at,
      event.observed_at, event.kind, event.session_id ?? null, event.project_id ?? null, JSON.stringify(event));
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
    const segments = this.sql.prepare(`SELECT started_at, last_seen_at, ended_at FROM activity_coverage
      WHERE started_at < ? AND COALESCE(ended_at, last_seen_at) >= ? ORDER BY started_at`).all(Date.parse(q.until), Date.parse(q.since)) as Coverage[];
    return {
      events: page.map(row => ({ ...activityEventSchema.parse(JSON.parse(row.data)), sequence: row.seq })),
      next_cursor: rows.length > q.limit ? Buffer.from(JSON.stringify({ v: 1, signature, after: page.at(-1)!.seq, high })).toString('base64url') : null,
      order: 'observation_sequence',
      coverage: { scope: 'this_machine', queried_at: this.now(), collector_running: this.segmentId !== null, segments,
        untracked: ['external_cli_without_adapter', 'foreground_dwell', 'device_call_history'],
        note: 'Only the recorded segments are covered; earlier history and gaps are unknown. Agent done is a turn ending, not task acceptance.' },
    };
  }
}
