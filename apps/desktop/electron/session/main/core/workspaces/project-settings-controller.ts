import { err, ok } from '@gugu/session-shared';
import { getEffectiveSessionSettings } from '@main/core/projects/settings/effective-session-settings';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import type { ProjectSettingsLoadResult } from '@shared/core/project-settings/project-settings';
import { createRPCController } from '@shared/lib/ipc/rpc';

async function getSettings(workspaceId: string): Promise<ProjectSettingsLoadResult> {
  const workspace = workspaceRegistry.get(workspaceId);
  if (!workspace) {
    return err({ type: 'not_found', entity: 'workspace', workspaceId });
  }

  return ok(
    await getEffectiveSessionSettings({
      projectSettings: workspace.settings,
      sessionFs: workspace.fileSystem,
      sessionConfigPath: workspace.configPath,
    })
  );
}

export const projectSettingsController = createRPCController({
  getSettings,
});
