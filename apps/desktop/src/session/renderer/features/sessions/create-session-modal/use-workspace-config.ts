import { useMemo } from 'react';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';

export type WorkspaceConfigState = {
  /** The resolved WorkspaceConfig to pass to createSession, or null when it cannot be built yet. */
  resolvedConfig: WorkspaceConfig | null;
  /** Whether enough information is present to submit the form. */
  isValid: boolean;
};

/**
 * A task runs in the project's own working tree — there is no branch, worktree or remote
 * machine to provision, so the config is fully determined by the repository workspace.
 */
export function useWorkspaceConfig(opts: {
  repositoryWorkspaceId: string | null | undefined;
}): WorkspaceConfigState {
  const { repositoryWorkspaceId } = opts;

  const resolvedConfig = useMemo(() => {
    if (!repositoryWorkspaceId) return null;
    return buildWorkspaceConfigFromPreset('repo-root', { repositoryWorkspaceId });
  }, [repositoryWorkspaceId]);

  return { resolvedConfig, isValid: resolvedConfig !== null };
}
