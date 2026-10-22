import Database from 'better-sqlite3';
import { sqlite } from '@main/db/client';
import { RESOURCE_HISTORY_LIMITS, type ResourceHistory, type ResourcePoint, type ResourceSnapshot } from '@shared/resource-monitor';

/** Local bounded history; SQLite reuses deleted pages. No timer or whole-history memory cache. */
export class ResourceHistoryStore {
  constructor(private readonly connection: Database.Database, private readonly limits = RESOURCE_HISTORY_LIMITS) {}

  append(snapshot: ResourceSnapshot): number {
    const json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.limits.bytes) throw new Error('A resource sample exceeds the history byte limit');
    return this.connection.transaction(() => {
      const cpu = snapshot.app.cpuPercent === undefined ? null : snapshot.app.cpuPercent + snapshot.entries.reduce((n, e) => n + e.cpu, 0);
      const memory = snapshot.app.memoryBytes === undefined ? null : snapshot.app.memoryBytes + snapshot.entries.reduce((n, e) => n + e.memory, 0);
      const id = Number(this.connection.prepare('INSERT INTO resource_history(timestamp,run_id,cpu,memory,bytes,snapshot) VALUES (?,?,?,?,?,?)')
        .run(snapshot.timestamp, snapshot.runId ?? '', cpu, memory, bytes, json).lastInsertRowid);
      this.connection.prepare(`DELETE FROM resource_history WHERE id <= (
        SELECT max(id) FROM (
          SELECT id,timestamp,row_number() OVER (ORDER BY id DESC) AS n,
            sum(bytes) OVER (ORDER BY id DESC) AS total FROM resource_history
        ) WHERE n > ? OR total > ? OR timestamp < ?
      )`).run(this.limits.points, this.limits.bytes, snapshot.timestamp - this.limits.ageMs);
      return id;
    })();
  }

  read(since = 0, until = Number.MAX_SAFE_INTEGER): ResourceHistory {
    const all = this.connection.prepare('SELECT id,timestamp,cpu,memory,run_id AS runId FROM resource_history WHERE timestamp BETWEEN ? AND ? ORDER BY id')
      .all(since, until) as ResourcePoint[];
    // Keep bucket maxima, not just every Nth point, so short CPU/memory spikes remain selectable.
    const points: ResourcePoint[] = [];
    const step = Math.max(1, Math.ceil(all.length / 299));
    for (let i = 0; i < all.length; i += step) {
      const bucket = all.slice(i, i + step);
      const cpu = bucket.reduce((a, b) => (b.cpu ?? -1) > (a.cpu ?? -1) ? b : a);
      const memory = bucket.reduce((a, b) => (b.memory ?? -1) > (a.memory ?? -1) ? b : a);
      points.push(...(cpu.id === memory.id ? [cpu] : [cpu, memory]).sort((a, b) => a.id - b.id));
    }
    if (all.length) points.push(all[0], all[all.length - 1]);
    const unique = [...new Map(points.map((p) => [p.id, p])).values()].sort((a, b) => a.id - b.id);
    const totals = this.connection.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM resource_history').get() as { count: number; bytes: number };
    return { points: unique.map((p) => ({ ...p, cpu: p.cpu ?? undefined, memory: p.memory ?? undefined })), ...totals, limits: this.limits };
  }

  point(id: number): ResourceSnapshot | null {
    const row = this.connection.prepare('SELECT snapshot FROM resource_history WHERE id=?').get(id) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as ResourceSnapshot : null;
  }

  clear(): void { this.connection.prepare('DELETE FROM resource_history').run(); }

  /** Stream raw rows from a WAL read snapshot; recording can continue on the writer connection. */
  async *export(): AsyncGenerator<string> {
    const reader = new Database(this.connection.name, { readonly: true, fileMustExist: true });
    try {
      reader.exec('BEGIN');
      const totals = reader.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM resource_history').get();
      yield JSON.stringify({ format: 'gugu-resource-monitor-timeline/1', limits: this.limits, ...totals as object }).slice(0, -1) + ',"samples":[';
      let separator = '';
      for (const row of reader.prepare('SELECT snapshot FROM resource_history ORDER BY id').iterate() as Iterable<{ snapshot: string }>) {
        yield separator + row.snapshot;
        separator = ',';
      }
      yield ']}';
    } finally { reader.close(); }
  }
}
export const resourceHistory = new ResourceHistoryStore(sqlite);
