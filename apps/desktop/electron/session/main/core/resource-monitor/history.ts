import type Database from 'better-sqlite3';
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
      // Walk newest first until any retention limit is reached; prune only older complete samples.
      const rows = this.connection.prepare('SELECT id,timestamp,bytes FROM resource_history ORDER BY id DESC').all() as { id: number; timestamp: number; bytes: number }[];
      let total = 0;
      const oldest = rows.find((row, i) => { total += row.bytes; return i >= this.limits.points || total > this.limits.bytes || row.timestamp < snapshot.timestamp - this.limits.ageMs; });
      if (oldest) {
        const removed = this.connection.prepare('DELETE FROM resource_history WHERE id <= ?').run(oldest.id).changes;
        this.connection.prepare('UPDATE resource_history_meta SET discarded=discarded+?').run(removed);
      }
      return id;
    })();
  }

  read(since = 0, until = Number.MAX_SAFE_INTEGER, pid?: number, runId?: string, creationTime?: number): ResourceHistory {
    const all = (pid === undefined
      ? this.connection.prepare('SELECT id,timestamp,cpu,memory,run_id AS runId FROM resource_history WHERE timestamp BETWEEN ? AND ? ORDER BY id').all(since, until)
      : this.connection.prepare(`SELECT h.id,h.timestamp,json_extract(p.value,'$.cpu') AS cpu,json_extract(p.value,'$.memory') AS memory,h.run_id AS runId
          FROM resource_history h,json_each(h.snapshot,'$.appProcesses') p
          WHERE h.timestamp BETWEEN ? AND ? AND h.run_id=? AND json_extract(p.value,'$.pid')=?
          AND (? IS NULL OR json_extract(p.value,'$.creationTime')=?) ORDER BY h.id`).all(since, until, runId ?? '', pid, creationTime ?? null, creationTime ?? null)) as ResourcePoint[];
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
    const { discarded } = this.connection.prepare('SELECT discarded FROM resource_history_meta').get() as { discarded: number };
    return { points: unique.map((p) => ({ ...p, cpu: p.cpu ?? undefined, memory: p.memory ?? undefined })), ...totals, discarded, limits: this.limits };
  }

  point(id: number): ResourceSnapshot | null {
    const row = this.connection.prepare('SELECT snapshot FROM resource_history WHERE id=?').get(id) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as ResourceSnapshot : null;
  }

  clear(): void {
    this.connection.transaction(() => {
      this.connection.prepare('DELETE FROM resource_history').run();
      this.connection.prepare('UPDATE resource_history_meta SET discarded=0').run();
    })();
  }

  export(): string {
    const rows = this.connection.prepare('SELECT snapshot FROM resource_history ORDER BY id').all() as { snapshot: string }[];
    return JSON.stringify({ format: 'gugu-resource-monitor-timeline/1', ...this.read(), samples: rows.map((r) => JSON.parse(r.snapshot)) });
  }
}
export const resourceHistory = new ResourceHistoryStore(sqlite);
