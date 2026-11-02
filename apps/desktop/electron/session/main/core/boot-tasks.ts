import { SessionBootTasks } from '@gugu/core/shared/sessionBootTasks';
import { log } from '@main/lib/logger';

// Owned by the backend bundle. The host uses this SAME instance through emdash-main-bridge.
export const sessionBootTasks = new SessionBootTasks((failure) => {
  log.warn('task boot operation failed; other tasks and host continue', failure);
});

/** The provider lifecycle is authoritative: a completed reopen supersedes its startup failure. */
export function clearRecoveredProjectBootFailures(isOpen: (projectId: string) => boolean) {
  for (const failure of sessionBootTasks.snapshot()) {
    if (failure.operation === 'project-open' && isOpen(failure.taskId)) {
      sessionBootTasks.clear('project-open', failure.taskId);
    }
  }
  return sessionBootTasks.snapshot();
}
