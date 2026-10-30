import { setTimeout as pause } from 'node:timers/promises';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { taskSearchDocuments } from '@gugu/session-core/session-record/search-documents';
import type { SearchIndexOp, SearchTask } from '@gugu/core/shared/search/types';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';
import { projectEvents } from '../projects/project-events';
import { sessionEvents } from '../sessions/session-events';
import type { MessageSearchStore } from './message-store';

type Stored = { seq: number; data: string; created_at: string };
type Write = (read: (store: MessageSearchStore) => readonly SearchIndexOp[]) => Promise<boolean>;

function task(id: string, agentUserId: string | null): SearchTask | undefined {
  const row = sqlite.prepare('SELECT id,title,project_id FROM sessions WHERE id=? AND archived_at IS NULL').get(id) as
    { id: string; title: string; project_id: string } | undefined;
  return row && { id: row.id, title: row.title, projectId: row.project_id, agentUserId };
}

function turnOp(taskId: string, row: Stored): SearchIndexOp {
  const turn = JSON.parse(row.data) as TranscriptTurn;
  return { kind: 'taskTurn', taskId, seq: row.seq, documents: taskSearchDocuments(taskId, { ...turn, seq: row.seq }, row.created_at) };
}

/** One cancellable reconciliation per account-index lifetime. No provider or network reads. */
export function startTaskSearch(store: MessageSearchStore, signal: AbortSignal, write: Write, identity: (sessionId: string, accountId: string) => Promise<string | null> = async () => null): void {
  const inventory = (sqlite.prepare(`SELECT id,title,project_id FROM sessions WHERE archived_at IS NULL
    ORDER BY (agent_status = 'running') ASC, updated_at DESC, id`).all() as { id: string; title: string; project_id: string }[])
    .map(row => ({ id: row.id, title: row.title, projectId: row.project_id }));
  store.apply([{ kind: 'tasks', tasks: inventory }]);
  const pending = new Set(inventory.map(row => row.id));
  let running = false;

  const backfill = async (id: string) => {
    const agentUserId = await identity(id, store.accountId);
    if (signal.aborted) return;
    // Resume the interrupted tail first, then validate the entire prefix before declaring completeness.
    // No source revision counter proves that an older turn stayed unchanged while the index was closed.
    let cursor = store.taskCoverage().find(row => row.taskId === id)?.lastSeq ?? -1;
    let validating = cursor < 0;
    while (!signal.aborted) {
      let done = false;
      const accepted = await write(() => {
        const meta = task(id, agentUserId);
        if (!meta) { done = true; return [{ kind: 'removeTask', taskId: id }]; }
        const rows = sqlite.prepare('SELECT seq,data,created_at FROM session_turns WHERE session_id=? AND seq>? ORDER BY seq LIMIT 50')
          .all(id, cursor) as Stored[];
        const ops: SearchIndexOp[] = [{ kind: 'task', task: meta }, ...rows.map(row => turnOp(id, row))];
        if (rows.length) {
          cursor = rows.at(-1)!.seq;
          ops.push({ kind: 'taskCoverage', coverage: { taskId: id, lastSeq: cursor, exhausted: false } });
        } else if (!validating) {
          validating = true;
          cursor = -1;
        } else {
          ops.push({ kind: 'truncateTask', taskId: id, fromSeq: cursor + 1 },
            { kind: 'taskCoverage', coverage: { taskId: id, lastSeq: cursor, exhausted: true } });
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
      for (const id of pending) {
        pending.delete(id);
        if (signal.aborted) break;
        try { await backfill(id); }
        catch (error) { if (!signal.aborted) log.error('Task search backfill failed', { sessionId: id, error: String(error) }); }
      }
    } finally { running = false; }
  };
  const reconcile = (id: string, scan = true) => {
    if (signal.aborted) return;
    const update = !scan || !task(id, null)
      ? write(current => {
        const meta = task(id, current.tasks().find(row => row.id === id)?.agentUserId ?? null);
        return meta ? [{ kind: 'task', task: meta }] : [{ kind: 'removeTask', taskId: id }];
      })
      : identity(id, store.accountId).then(agentUserId => write(() => {
        const meta = task(id, agentUserId);
        return meta ? [{ kind: 'task', task: meta }] : [{ kind: 'removeTask', taskId: id }];
      }));
    void update.then(accepted => {
      if (accepted && scan && !signal.aborted) { pending.add(id); void drain(); }
    }).catch(error => log.error('Task search reconciliation failed', { sessionId: id, error: String(error) }));
  };
  // Source transactions stay on their own queue. Their same-tick facts share one derived transaction.
  const changes = new Map<string, { sessionId: string; seq?: number; fromSeq?: number }>();
  let scheduled = false;
  const changed = (change: { sessionId: string; seq?: number; fromSeq?: number }) => {
    const key = `${change.sessionId}:${change.seq ?? 'truncate'}`;
    const previous = changes.get(key);
    changes.set(key, change.fromSeq === undefined ? change : { ...change, fromSeq: Math.min(previous?.fromSeq ?? change.fromSeq, change.fromSeq) });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = [...changes.values()];
      changes.clear();
      if (signal.aborted) return;
      const ids = [...new Set(batch.map(change => change.sessionId))];
      void Promise.all(ids.map(async id => [id, await identity(id, store.accountId)] as const)).then(entries => {
        const identities = new Map(entries);
        return write(() => {
          const ops: SearchIndexOp[] = [];
          for (const id of ids) {
            const meta = task(id, identities.get(id) ?? null);
            if (!meta) { ops.push({ kind: 'removeTask', taskId: id }); continue; }
            ops.push({ kind: 'task', task: meta });
            const own = batch.filter(change => change.sessionId === id);
            const cuts = own.flatMap(change => change.fromSeq === undefined ? [] : [change.fromSeq]);
            const cut = cuts.length ? Math.min(...cuts) : undefined;
            if (cut !== undefined) {
              // A later source commit may already have reused the truncated sequence. Read the current suffix;
              // applying an old cut alone after that new commit would delete its valid replacement from search.
              ops.push({ kind: 'truncateTask', taskId: id, fromSeq: cut });
              const suffix = sqlite.prepare('SELECT seq,data,created_at FROM session_turns WHERE session_id=? AND seq>=? ORDER BY seq').all(id, cut) as Stored[];
              ops.push(...suffix.map(row => turnOp(id, row)));
            }
            for (const { seq } of own) {
              if (seq === undefined || (cut !== undefined && seq >= cut)) continue;
              const row = sqlite.prepare('SELECT seq,data,created_at FROM session_turns WHERE session_id=? AND seq=?').get(id, seq) as Stored | undefined;
              ops.push(row ? turnOp(id, row) : { kind: 'taskTurn', taskId: id, seq, documents: [] });
            }
          }
          return ops;
        });
      }).then(accepted => {
        if (accepted) for (const change of batch) if (change.fromSeq !== undefined) reconcile(change.sessionId);
      }).catch(error => log.error('Task search commit feed failed', { error: String(error) }));
    });
  };
  const off = [
    projectEvents.on('project:deleted', projectId => {
      if (signal.aborted) return;
      return write(current => current.tasks().filter(row => row.projectId === projectId && !task(row.id, row.agentUserId ?? null))
        .map(row => ({ kind: 'removeTask' as const, taskId: row.id }))).then(() => {});
    }),
    sessionEvents.on('session:history-changed', changed),
    sessionEvents.on('session:created', row => reconcile(row.id)),
    sessionEvents.on('session:renamed', id => reconcile(id, false)),
    sessionEvents.on('session:deleted', id => reconcile(id, false)),
    sessionEvents.on('session:visibility-changed', id => reconcile(id)),
  ];
  signal.addEventListener('abort', () => { for (const unsubscribe of off) unsubscribe(); pending.clear(); changes.clear(); }, { once: true });
  void drain();
}
