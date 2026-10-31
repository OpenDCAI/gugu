import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';
import { agentStatusWriter } from '../agent-status/agent-status-writer';
import { syncStoredHistoryFromRecord } from './record-backfill';
import { sessionsAliveInTmux } from './session-process';

/**
 * Terminal tasks whose record must be read once at boot, from facts that were persisted before this host started:
 * the task was running at shutdown (its status, read before the boot sweep settles it), or its stored record turn is
 * still unfinished while tmux still runs its engine (a reply that was being written when the host stopped).
 * Everything else was read at its settled edge and is not read again.
 */
export function ptyRecordResumeSet(tmuxSessionNames: ReadonlySet<string>): string[] {
  const alive = sessionsAliveInTmux(tmuxSessionNames);
  const rows = sqlite.prepare(`SELECT id, agent_status AS status, EXISTS (SELECT 1 FROM session_turns t WHERE t.session_id = sessions.id
      AND t.turn_id LIKE 'record:%' AND json_extract(t.data, '$.outcome.kind') IS NULL) AS unfinished
    FROM sessions WHERE runtime IS NULL OR runtime = 'pty'`).all() as { id: string; status: string | null; unfinished: number }[];
  return rows.filter(row => {
    const status = parseAgentStatus(row.status);
    return isAgentActive(status ? { status } : null) || (row.unfinished === 1 && alive.has(row.id));
  }).map(row => row.id);
}

/**
 * The one entry by which a terminal task's turns reach session_turns: its own record, read at the session's settled edge.
 * A record still being written (`settling`: the harness reported idle before its buffered write landed) is followed through
 * the live record reader until its last turn lands, then read again; a new turn ends that watch.
 */
export function startPtyRecordSync(resume: readonly string[]): () => void {
  const running = new Set((sqlite.prepare('SELECT id, agent_status AS status FROM sessions').all() as { id: string; status: string | null }[])
    .filter(row => { const status = parseAgentStatus(row.status); return isAgentActive(status ? { status } : null); }).map(row => row.id));
  const watches = new Map<string, AbortController>();
  const unwatch = (id: string) => { watches.get(id)?.abort(); watches.delete(id); };
  const read = (id: string): void => {
    syncStoredHistoryFromRecord(id, { runtime: 'pty' }).then(result => { if (result.status === 'settling') watch(id); })
      .catch(error => log.error('[pty-record-sync] record read failed', { sessionId: id, error: String(error) }));
  };
  const watch = (id: string) => {
    unwatch(id);
    const controller = new AbortController();
    watches.set(id, controller);
    import('@main/core/session-timeline/service').then(({ watchRecordSettled }) => watchRecordSettled(id, controller.signal)).then(settled => {
      if (!settled || watches.get(id) !== controller) return;
      watches.delete(id);
      read(id);
    }, error => log.error('[pty-record-sync] record watch failed', { sessionId: id, error: String(error) }));
  };
  const off = agentStatusWriter.on('agent:status', change => {
    const wasRunning = running.has(change.sessionId);
    if (change.reading.running) { running.add(change.sessionId); unwatch(change.sessionId); }
    else running.delete(change.sessionId);
    if (wasRunning && !change.reading.running) read(change.sessionId);
  });
  for (const id of resume) read(id);
  return () => { off(); for (const controller of watches.values()) controller.abort(); watches.clear(); running.clear(); };
}
