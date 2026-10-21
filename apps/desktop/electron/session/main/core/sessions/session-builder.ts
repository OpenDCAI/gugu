import type { GitBranchRef } from '@gugu/session-core/git';
import type { SessionProvider } from '@main/core/sessions/types';
import type { TerminalProvider } from '@main/core/terminals/terminal-provider';
import type { Workspace } from '@main/core/workspaces/workspace';
import { events } from '@main/lib/events';
import { sessionProvisionProgressChannel, type ProvisionStep } from '@shared/core/sessions/provisionEvents';
import type { SessionMount } from '../projects/project-provider';
import type { ProjectSettingsProvider } from '../projects/settings/provider';
import {
  buildSessionProviders,
  resolveSessionEnv,
} from '../workspaces/workspace-factory';
import { sessionProvisionEvents } from './session-provision-events';

/** 一个挂载为谁而建:会话的 id 与标题(标题给 lifecycle 脚本的环境变量)。 */
export type MountedSession = { id: string; title: string };

export function emitSessionProvisionProgress(data: {
  sessionId: string;
  projectId: string;
  step: ProvisionStep;
  message: string;
}): void {
  events.emit(sessionProvisionProgressChannel, data);
  sessionProvisionEvents.emitProgress(data);
}

export type BuildSessionResult = {
  sessionMount: SessionMount;
  sessionProvider: SessionProvider;
  terminalProvider: TerminalProvider;
};

/**
 * Shared tail of the provision flow — builds a SessionMount from an already-acquired
 * workspace.
 *
 * Returns all three provider objects so callers can keep references.
 *
 * `workspaceBranchName` and `workspaceSourceBranch` are sourced from the
 * workspace row (not the task row), and flow through to `SessionMount` for
 * PTY env var population.
 */
export async function buildSessionFromWorkspace(
  session: MountedSession,
  workspace: Workspace,
  projectId: string,
  projectPath: string,
  settings: ProjectSettingsProvider,
  workspaceBranchName?: string,
  workspaceSourceBranch?: GitBranchRef
): Promise<BuildSessionResult> {
  const { sessionEnvVars, tmuxEnabled, shellSetup } = await resolveSessionEnv(
    session,
    workspace,
    projectPath,
    settings,
    projectId
  );

  const { sessions: sessionProvider, terminals: terminalProvider } =
    await buildSessionProviders({
      projectId,
      sessionId: session.id,
      workspaceId: workspace.id,
      sessionPath: workspace.path,
      tmuxEnabled,
      shellSetup,
      sessionEnvVars,
    });

  const sessionMount: SessionMount = {
    sessionId: session.id,
    sessionBranch: workspaceBranchName,
    sourceBranch: workspaceSourceBranch,
    sessionEnvVars,
    sessions: sessionProvider,
    terminals: terminalProvider,
    workspaceKind: 'local',
    sessionPath: workspace.path,
  };

  return { sessionMount, sessionProvider, terminalProvider };
}
