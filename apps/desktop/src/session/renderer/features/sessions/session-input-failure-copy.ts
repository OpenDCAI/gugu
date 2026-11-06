import type { SessionTranslate } from './stores/session-failure-message';
import type { SessionFailure } from './stores/session-failure';

/** Known startup diagnostics have a specific repair; unknown diagnostics stay in the log. */
export function codexNeedsUpgrade(reason: string): boolean {
  return /Codex.*(?:app-server|models --bundled)|local Codex app-server/i.test(reason);
}

export function sessionStartupFailureCopy(reason: string, translate: SessionTranslate): string {
  return translate(codexNeedsUpgrade(reason) ? 'taskError.codexUpgrade' : 'taskError.startFailedRetry');
}

/** Creation errors are application failures, unlike raw failed-turn contents in the transcript. */
export function creationFailureCopy(failure: SessionFailure, translate: SessionTranslate): string {
  switch (failure.kind) {
    case 'raw': return translate(codexNeedsUpgrade(failure.detail) ? 'taskError.codexUpgrade' : 'taskError.createFailedRetry');
    case 'harness-unavailable': return translate(failure.reason === 'updating' ? 'taskError.harnessUpdating' : 'taskError.harnessMissing', { harnessName: failure.harnessName });
    case 'project-not-found': return translate('taskError.createProjectMissing');
    case 'workspace-no-intent':
    case 'workspace-missing': return translate('taskError.createWorkspaceMissing');
    case 'setup-step-failed': return translate('taskError.createSetupFailed');
    case 'provision-timeout': return translate('taskError.createTimedOut');
  }
}
