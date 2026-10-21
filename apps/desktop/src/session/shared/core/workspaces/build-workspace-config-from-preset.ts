import type { WorkspaceConfig } from './workspace-config';
import type { PresetContext, WorkspacePresetId } from './workspace-presets';

/**
 * Builds a `WorkspaceConfig` from a preset ID and context.
 *
 * This is a pure function with no side effects — safe to call in both the renderer
 * and the main process.
 *
 * Throws when required context fields are missing for the given preset.
 */
export function buildWorkspaceConfigFromPreset(
  presetId: WorkspacePresetId,
  context: PresetContext
): WorkspaceConfig {
  switch (presetId) {
    case 'repo-root': {
      const workspaceId = context.repositoryWorkspaceId;
      if (!workspaceId) {
        throw new Error('repo-root preset requires repositoryWorkspaceId in context');
      }
      return {
        version: '2',
        workspace: { kind: 'repository-instance', workspaceId },
      };
    }
  }
}
