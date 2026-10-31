import { setTimeout as pause } from 'node:timers/promises';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { taskSearchDocuments } from '@gugu/session-core/session-record/search-documents';
import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import type { SearchIndexOp, SearchTask, SearchTaskCoverage } from '@gugu/core/shared/search/types';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';
import { projectEvents } from '../projects/project-events';
import { filterReadableStoredRows } from '../sessions/session-turn-replay';
import { sessionEvents } from '../sessions/session-events';
import { agentStatusWriter } from '../agent-status/agent-status-writer';
import { syncStoredHistoryFromRecord } from '../sessions/record-backfill';
import type { MessageSearchStore } from './message-store';
import { localProjectsOnly } from './local-projects-only';

type Stored = { seq: number; data: string; turnId: string };
type Write = (read: (store: MessageSearchStore) => readonly SearchIndexOp[]) => Promise<boolean>;
type Scan = { from: number; validate: boolean; record: boolean };
const PAGE_BYTES = 1024 * 1024;

function task(id: string, agentUserId: string | null): SearchTask | undefined {
  const row = sqlite.prepare(`SELECT id,title,project_id,runtime,archived_at FROM sessions WHERE id=?
    AND ${localProjectsOnly('sessions.project_id')}`).get(id) as
    { id: string; title: string; project_id: string; runtime: string | null; archived_at: string | null } | undefined;
  return row && { id: row.id, title: row.title, projectId: row.project_id, agentUserId, terminal: row.runtime !== 'acp', archived: row.archived_at !== null };
}

/** Bound each page by source bytes. An indivisible oversized turn is read alone, never truncated. */
function page(id: string, cursor: number): Stored[] {
  let bytes = 0;
  let last = cursor;
  for (const row of sqlite.prepare(`SELECT seq,length(CAST(data AS BLOB)) AS bytes FROM session_turns
    WHERE session_id=? AND seq>? ORDER BY seq`).iterate(id, cursor) as Iterable<{ seq: number; bytes: number }>) {
    if (last !== cursor && bytes + row.bytes > PAGE_BYTES) break;
    last = row.seq;
    bytes += row.bytes;
    if (bytes >= PAGE_BYTES) break;
  }
  return last === cursor ? [] : sqlite.prepare(`SELECT seq,data,turn_id AS turnId FROM session_turns
    WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq`).all(id, cursor, last) as Stored[];
}

function turnOps(id: string, rows: Stored[]): SearchIndexOp[] {
  if (!rows.length) return [];
  const previous = sqlite.prepare(`SELECT data FROM session_turns WHERE session_id=? AND seq<?
    AND json_extract(data,'$.outcome.kind') IS NOT NULL AND json_extract(data,'$.startedAt') IS NOT NULL
    ORDER BY seq DESC LIMIT 1`).get(id, rows[0].seq) as { data: string } | undefined;
  const parsed = rows.map(row => ({ ...row, turn: JSON.parse(row.data) as TranscriptTurn }));
  const visible = new Set(filterReadableStoredRows(parsed, previous ? JSON.parse(previous.data) as TranscriptTurn : null).map(row => row.seq));
  return parsed.map(row => ({ kind: 'taskTurn', taskId: id, seq: row.seq,
    documents: visible.has(row.seq) ? taskSearchDocuments(id, { ...row.turn, seq: row.seq }) : [] }));
}

/** One account-owned serial feed. Record history enters canonical storage before the same index projection. */
export function startTaskSearch(store: MessageSearchStore, signal: AbortSignal, write: Write, identity: (sessionId: string, accountId: string) => Promise<string | null> = async () => null): void {
  const inventory = (sqlite.prepare(`SELECT id,title,project_id,runtime,agent_status,archived_at FROM sessions WHERE
    ${localProjectsOnly('sessions.project_id')}
    ORDER BY updated_at DESC, id`).all() as { id: string; title: string; project_id: string; runtime: string | null; agent_status: string | null; archived_at: string | null }[])
    .map(row => {
      const status = parseAgentStatus(row.agent_status);
      return { task: { id: row.id, title: row.title, projectId: row.project_id, terminal: row.runtime !== 'acp', archived: row.archived_at !== null }, active: isAgentActive(status ? { status } : null) };
    })
    .sort((a, b) => Number(a.active) - Number(b.active));
  store.apply([{ kind: 'tasks', tasks: inventory.map(row => row.task) }]);
  const persisted = new Map(store.taskCoverage({ persisted: true }).map(row => [row.taskId, row]));
  const runningTasks = new Set(inventory.filter(row => row.active).map(row => row.task.id));
  const pending = new Map<string, Scan>(inventory.map(({ task: row }) => {
    const coverage = persisted.get(row.id);
    return [row.id, { from: -1, validate: true, record: !coverage?.exhausted || !!coverage.reason }];
  }));
  let running = false;

  const backfill = async (id: string, scan: Scan) => {
    const agentUserId = await identity(id, store.accountId);
    if (signal.aborted) return;
    let reason: SearchTaskCoverage['reason'] = store.taskCoverage().find(row => row.taskId === id)?.reason;
    if (scan.record && task(id, agentUserId)?.terminal) {
      const result = await syncStoredHistoryFromRecord(id, { signal, runtime: 'pty' });
      if (signal.aborted) return;
      reason = result.status === 'complete' || result.status === 'runtime-changed' ? undefined
        : result.status === 'cancelled' ? 'unavailable' : result.status;
    }
    let highWater = store.taskCoverage().find(row => row.taskId === id)?.lastSeq ?? -1;
    // Resume the interrupted tail first, then validate the prefix. Its cursor must not overwrite highWater.
    let cursor = scan.validate ? highWater : scan.from - 1;
    let validating = !scan.validate || cursor < 0;
    while (!signal.aborted) {
      let done = false;
      const accepted = await write(current => {
        highWater = Math.max(highWater, current.taskCoverage().find(row => row.taskId === id)?.lastSeq ?? -1);
        const meta = task(id, agentUserId);
        if (!meta) { done = true; return [{ kind: 'removeTask', taskId: id }]; }
        const rows = page(id, cursor);
        const ops: SearchIndexOp[] = [{ kind: 'task', task: meta }, ...turnOps(id, rows)];
        if (rows.length) {
          cursor = rows.at(-1)!.seq;
          highWater = Math.max(highWater, cursor);
          ops.push({ kind: 'taskCoverage', coverage: { taskId: id, lastSeq: highWater, exhausted: false, reason } });
        } else if (!validating) {
          validating = true;
          cursor = -1;
        } else {
          const last = sqlite.prepare('SELECT max(seq) AS seq FROM session_turns WHERE session_id=?').get(id) as { seq: number | null };
          ops.push({ kind: 'truncateTask', taskId: id, fromSeq: cursor + 1 },
            { kind: 'taskCoverage', coverage: { taskId: id, lastSeq: last.seq ?? -1,
              exhausted: reason !== 'active' && reason !== 'unavailable' && !pending.has(id), reason } });
          done = true;
        }
        return ops;
      });
      if (!accepted || done) return;
      await pause(200, undefined, { signal });
    }
  };
  const drain = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      for (const [id, scan] of pending) {
        pending.delete(id);
        if (signal.aborted) break;
        try { await backfill(id, scan); if (!signal.aborted) await pause(200, undefined, { signal }); }
        catch (error) { if (!signal.aborted) log.error('Task search backfill failed', { sessionId: id, error: String(error) }); }
      }
    } finally { running = false; }
  };
  const reconcile = (id: string, from = -1, scan = true, record = false) => {
    if (signal.aborted) return;
    const coverage = store.taskCoverage().find(row => row.taskId === id);
    if (scan) {
      const prior = pending.get(id);
      pending.set(id, { from: Math.min(prior?.from ?? from, from), validate: prior?.validate || from < 0 || !coverage?.exhausted,
        record: prior?.record === true || record });
    }
    void write(current => {
      const meta = task(id, current.tasks().find(row => row.id === id)?.agentUserId ?? null);
      if (!meta) return [{ kind: 'removeTask', taskId: id }];
      const ops: SearchIndexOp[] = [{ kind: 'task', task: meta }];
      const latest = current.taskCoverage().find(row => row.taskId === id);
      if (scan) {
        // A lifecycle edge validates existing rows in place. Only a committed suffix change invalidates that suffix.
        if (from >= 0) ops.push({ kind: 'truncateTask', taskId: id, fromSeq: from });
        ops.push({ kind: 'taskCoverage', coverage: { taskId: id, lastSeq: latest?.lastSeq ?? -1, exhausted: false, reason: latest?.reason } });
      }
      return ops;
    }).then(accepted => { if (accepted && scan && !signal.aborted) void drain(); })
      .catch(error => log.error('Task search reconciliation failed', { sessionId: id, error: String(error) }));
  };
  // Coalesce committed changes at the oldest affected sequence. Replay visibility can depend on its predecessor,
  // so revisions and truncations both reproject the current suffix through the same bounded paging path.
  const changes = new Map<string, number>();
  const changed = (change: { sessionId: string; seq?: number; fromSeq?: number }) => {
    const scheduled = changes.size > 0;
    const from = change.fromSeq ?? change.seq ?? 0;
    changes.set(change.sessionId, Math.min(changes.get(change.sessionId) ?? from, from));
    if (scheduled) return;
    queueMicrotask(() => {
      const batch = [...changes];
      changes.clear();
      for (const [id, first] of batch) reconcile(id, first);
    });
  };
  const off = [
    projectEvents.on('project:deleted', projectId => {
      if (signal.aborted) return;
      return write(current => current.tasks().filter(row => row.projectId === projectId && !task(row.id, row.agentUserId ?? null))
        .map(row => ({ kind: 'removeTask' as const, taskId: row.id }))).then(() => {});
    }),
    sessionEvents.on('session:history-changed', changed),
    sessionEvents.on('session:created', row => reconcile(row.id, -1, true, true)),
    sessionEvents.on('session:renamed', id => reconcile(id, -1, false)),
    sessionEvents.on('session:deleted', id => { runningTasks.delete(id); reconcile(id, -1, false); }),
    sessionEvents.on('session:archived', id => reconcile(id, -1, true, true)),
    agentStatusWriter.on('agent:status', change => {
      const wasRunning = runningTasks.has(change.sessionId);
      if (change.reading.running) runningTasks.add(change.sessionId);
      else runningTasks.delete(change.sessionId);
      if (wasRunning && !change.reading.running) reconcile(change.sessionId, -1, true, true);
    }),
  ];
  signal.addEventListener('abort', () => { for (const unsubscribe of off) unsubscribe(); pending.clear(); changes.clear(); runningTasks.clear(); }, { once: true });
  void drain();
}
