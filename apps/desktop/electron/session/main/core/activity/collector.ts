import { randomUUID } from 'node:crypto';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';
import { sessionEvents } from '@main/core/sessions/session-events';
import { projectEvents } from '@main/core/projects/project-events';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { sqliteTextToMs } from '@main/core/usage/local-day';
import { ActivityJournal } from './journal';
import { onActivitySignal } from './signals';
import type { ConfirmedSleep } from './confirmed-sleep';

let journal: ActivityJournal | null = null;
export function activityJournal(): ActivityJournal {
  if (!journal) throw new Error('Activity collector is not initialized on this host');
  return journal;
}

export function recordConfirmedDeviceSleep(sleep: ConfirmedSleep): boolean {
  if (!journal) return false;
  try {
    journal.append({ event_id: `device.sleep:${sleep.source}:${sleep.since}:${sleep.until}`, kind: 'device.sleep',
      occurred_at: sleep.since, sleep_until_at: sleep.until, sleep_source: sleep.source, observed_at: Date.now() });
  } catch (error) { journal.failed(); throw error; }
  return true;
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
    projectEvents.on('project:created', project => observe({ event_id: randomUUID(), kind: 'project.created',
      object_id: project.id, occurred_at: sqliteTextToMs(project.createdAt) })),
    projectEvents.on('project:deleted', projectId => observe({ event_id: randomUUID(), kind: 'project.deleted',
      object_id: projectId, occurred_at: null })),
    agentStatusWriter.on('agent:status', change => {
      if (change.activityAt === undefined) return; // Read/unread changes are not work activity.
      observe({ event_id: randomUUID(), kind: 'agent.status', session_id: change.sessionId,
        occurred_at: change.activityAt, status: change.reading.status,
        detail: change.reading.detail });
    }),
    sessionEvents.on('session:created', session => observe({ event_id: `session.created:${session.id}`,
      kind: 'session.created', session_id: session.id, occurred_at: sqliteTextToMs(session.createdAt),
      ...(session.agentStatus ? { status: session.agentStatus, detail: session.agentStatusDetail ?? null } : {}),
      ...(session.parentSessionId ? { parent_session_id: session.parentSessionId } : {}),
      ...(session.spawnedBySessionId ? { spawned_by_session_id: session.spawnedBySessionId } : {}) })),
    sessionEvents.on('session:renamed', sessionId => observe({ event_id: randomUUID(),
      kind: 'session.renamed', session_id: sessionId, occurred_at: null })),
    sessionEvents.on('session:archived', sessionId => observe({ event_id: randomUUID(),
      kind: 'session.archived', session_id: sessionId, occurred_at: null })),
    sessionEvents.on('session:deleted', sessionId => observe({ event_id: randomUUID(),
      kind: 'session.deleted', session_id: sessionId, occurred_at: null })),
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
