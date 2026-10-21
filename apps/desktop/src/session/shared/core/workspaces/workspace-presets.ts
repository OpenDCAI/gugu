/**
 * Where a task's session runs. A task always works in an existing workspace —
 * the project's own directory; the product never provisions a git worktree and never
 * creates a task branch. A session that wants isolation creates its own worktree from inside.
 */
export type WorkspacePresetId = 'repo-root';

export type PresetContext = {
  /** The workspace ID of the project's repository-root workspace. */
  repositoryWorkspaceId?: string;
};
