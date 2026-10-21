import { log } from '@main/lib/logger';
import type { AutomationRun, RunError } from '@shared/core/automations/automation-run';
import { updateRun } from './repo';

export type OnStepCompleted = (run: AutomationRun) => void;

type RunUpdateValues = Parameters<typeof updateRun>[1];

export async function updateRunOrThrow(
  runId: string,
  values: RunUpdateValues
): Promise<AutomationRun> {
  const run = await updateRun(runId, values);
  if (!run) {
    log.error('Automation run update failed', { runId, values });
    throw new Error('run_update_failed');
  }
  return run;
}

/** creating_session → launching_session, writes sessionCreatedAt */
export async function markRunLaunchingSession(runId: string, now: number): Promise<AutomationRun> {
  return updateRunOrThrow(runId, { status: 'launching_session', sessionCreatedAt: now });
}

/** launching_session → starting_agent, writes launchedAt */
export async function markRunStartingAgent(
  runId: string,
  now: number
): Promise<AutomationRun> {
  return updateRunOrThrow(runId, { status: 'starting_agent', launchedAt: now });
}

/** starting_agent → done, writes finishedAt */
export async function markRunDone(runId: string, finishedAt: number): Promise<AutomationRun> {
  return updateRunOrThrow(runId, { status: 'done', finishedAt });
}

/** any step → failed, writes JSON error + finishedAt */
export async function markRunFailed(
  runId: string,
  error: RunError,
  finishedAt?: number
): Promise<AutomationRun> {
  return updateRunOrThrow(runId, {
    status: 'failed',
    error,
    finishedAt: finishedAt ?? Date.now(),
  });
}

/** queued → skipped, writes JSON error + finishedAt */
export async function markRunSkipped(runId: string, error: RunError): Promise<AutomationRun> {
  return updateRunOrThrow(runId, {
    status: 'skipped',
    error,
    finishedAt: Date.now(),
  });
}
