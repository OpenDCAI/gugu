import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import type { ProjectPathConflict } from '@shared/projects';

/** Keep path-conflict diagnostics typed until a UI boundary instead of parsing SQLite text. */
export class ProjectPathConflictError extends Error {
  readonly conflict: ProjectPathConflict;

  constructor(conflict: ProjectPathConflict) {
    super(
      `That path is already taken by ${conflict.workspaceProvider} project "${conflict.name}" (${conflict.id}). ` +
        'Remove or move that project first.'
    );
    this.name = 'ProjectPathConflictError';
    this.conflict = conflict;
  }
}

export function isProjectPathConflictError(error: unknown): error is ProjectPathConflictError {
  return error instanceof ProjectPathConflictError;
}

export function projectPathConflictMessage(
  error: ProjectPathConflictError,
  translate: ProjectsTranslate
): string {
  const provider =
    error.conflict.workspaceProvider === 'ssh'
      ? translate('projects.create.providerSsh')
      : translate('projects.create.providerLocal');
  return translate('projects.create.pathConflict', {
    provider,
    name: error.conflict.name,
    id: error.conflict.id,
  });
}
