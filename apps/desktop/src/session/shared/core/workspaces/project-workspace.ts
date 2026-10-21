import type { WorkspaceConfig } from './workspace-config';
import type { WorkspaceKind } from './workspaces';

/**
 * A workspace belonging to a project, as returned by `getProjectWorkspaces`.
 * Includes the project-root workspace and all worktrees linked through sessions.
 */
export type ProjectWorkspace = {
  id: string;
  kind: WorkspaceKind;
  path: string | null;
  branchName: string | null;
  config: WorkspaceConfig | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  /** A session that runs in this workspace, if any. Null for the project-root workspace. */
  sessionId: string | null;
  title: string | null;
  /** Whether the workspace is currently acquired in the in-memory registry. */
  isLive: boolean;
  /** Number of non-archived sessions currently linked to this workspace. */
  linkedSessionCount: number;
};
