import { randomUUID } from 'node:crypto';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';
import { sessionEvents } from '@main/core/sessions/session-events';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { sqliteTextToMs } from '@main/core/usage/local-day';
import { ActivityJournal } from './journal';
import { onActivitySignal } from './signals';

let journal: ActivityJournal | null = null;
export function activityJournal(): ActivityJournal {
  if (!journal) throw new Error('Activity collector is not initialized on this host');
  return journal;
}

/** Start before event producers; shutdown before the SQLite connection closes. */
export function installActivityCollector(): () => void {
  if (journal) throw new Error('Activity collector is already installed');
  const recorder = new ActivityJournal(sqlite);
  recorder.start();
  journal = recorder;
  const safely = (action: () => void) => {
    try { action(); } catch (error) {
      recorder.failed();
      log.error('Activity capture failed; activity queries will report incomplete coverage', error);
    }
  };
  const observe: Parameters<typeof onActivitySignal>[0] = e => safely(() => recorder.append({ ...e, observed_at: Date.now() }));
  const offs = [onActivitySignal(observe),
    agentStatusWriter.on('agent:status', change => {
      if (change.activityAt === undefined) return; // Read/unread changes are not work activity.
      observe({ event_id: randomUUID(), kind: 'agent.status', session_id: change.sessionId,
        project_id: change.projectId, occurred_at: change.activityAt, status: change.reading.status,
        detail: change.reading.detail,
        ...(change.turnId ? { turn_id: change.turnId } : {}) });
    }),
    sessionEvents.on('session:created', session => observe({ event_id: `session.created:${session.id}`,
      kind: 'session.created', session_id: session.id, project_id: session.projectId, occurred_at: sqliteTextToMs(session.createdAt),
      ...(session.agentStatus ? { status: session.agentStatus, detail: session.agentStatusDetail ?? null } : {}),
      ...(session.parentSessionId ? { parent_session_id: session.parentSessionId } : {}),
      ...(session.spawnedBySessionId ? { spawned_by_session_id: session.spawnedBySessionId } : {}) })),
    sessionEvents.on('session:renamed', (sessionId, projectId) => observe({ event_id: randomUUID(),
      kind: 'session.renamed', session_id: sessionId, project_id: projectId, occurred_at: null })),
    sessionEvents.on('session:archived', sessionId => observe({ event_id: randomUUID(),
      kind: 'session.archived', session_id: sessionId, occurred_at: null })),
    sessionEvents.on('session:deleted', sessionId => observe({ event_id: randomUUID(),
      kind: 'session.deleted', session_id: sessionId, occurred_at: null })),
    sessionEvents.on('session:input-submitted', input => observe({ event_id: randomUUID(),
      kind: 'session.input_submitted', session_id: input.sessionId, project_id: input.projectId, occurred_at: null })),
  ];
  const timer = setInterval(() => safely(() => recorder.heartbeat()), 60_000);
  timer.unref();
  return () => {
    for (const off of offs) off();
    clearInterval(timer);
    safely(() => recorder.stop());
    journal = null;
  };
}
