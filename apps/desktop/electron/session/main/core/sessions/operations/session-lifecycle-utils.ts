import path from 'node:path';
import { createBoundExec } from '@gugu/session-core/exec';
import { FileSystem, isFileNotFoundError } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';
import { and, eq, ne } from 'drizzle-orm';
import { NON_INTERACTIVE_GIT_ENV } from '@main/core/execution-context/non-interactive-git-env';
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service';
import { getGitExecutable } from '@main/core/utils/exec';
import { isRetiredRemoteWorkspace, resolveWorkspaceKind } from '@main/core/workspaces/resolve-workspace-kind';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { WorkspaceKind, WorkspaceType } from '@shared/core/workspaces/workspaces';

const localFileSystem = new FileSystem();

export type LocalWorkspaceCleanupTarget = {
  id?: string;
  kind?: WorkspaceKind | null;
  type?: WorkspaceType | null;
  location?: 'local' | 'remote' | null;
  path?: string | null;
};

export async function pathExists(filePath: string): Promise<boolean> {
  const exists = await localFileSystem.exists(filePath);
  return exists.success && exists.data;
}

function isWorktreeWorkspace(workspace: LocalWorkspaceCleanupTarget): boolean {
  if (!workspace.type) return workspace.kind === 'worktree';
  return (
    resolveWorkspaceKind({
      kind: workspace.kind,
      type: workspace.type,
      path: workspace.path,
    }) === 'worktree'
  );
}

async function pruneGitWorktrees(projectPath: string): Promise<void> {
  try {
    const gitExec = createBoundExec({
      file: getGitExecutable(),
      cwd: projectPath,
      env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
    });
    await gitExec.exec(['worktree', 'prune'], { timeoutMs: 5_000 });
  } catch (error) {
    log.warn('git worktree prune failed after worktree cleanup', {
      projectPath,
      error: String(error),
    });
  }
}

export type OwnedWorktreeCleanupError =
  | { type: 'project-root-refused'; path: string; message: string }
  | { type: 'removal-failed'; path: string; message: string };

/**
 * Removes the recorded worktree directory of a local workspace. Fallback for
 * session deletion when the project provider is unavailable or its git-based
 * removal did not apply.
 *
 * Returns `ok(true)` when the directory was removed, `ok(false)` when the
 * workspace is not an owned local worktree (nothing to do).
 */
export async function removeOwnedLocalWorktreeDirectory(
  workspace: LocalWorkspaceCleanupTarget,
  projectPath: string
): Promise<Result<boolean, OwnedWorktreeCleanupError>> {
  if (!workspace.path || isRetiredRemoteWorkspace(workspace)) return ok(false);

  const workspacePath = path.resolve(workspace.path);
  const projectRootPath = path.resolve(projectPath);
  if (workspacePath === projectRootPath) {
    if (workspace.kind === 'worktree') {
      return err({
        type: 'project-root-refused',
        path: workspace.path,
        message: `Refusing to remove project root path "${workspace.path}"`,
      });
    }
    return ok(false);
  }

  if (!isWorktreeWorkspace(workspace)) return ok(false);

  const removal = await localFileSystem.remove(workspacePath, { recursive: true });
  if (!removal.success && !isFileNotFoundError(removal.error)) {
    return err({
      type: 'removal-failed',
      path: workspace.path,
      message: removal.error.message,
    });
  }

  if (await pathExists(workspacePath)) {
    return err({
      type: 'removal-failed',
      path: workspace.path,
      message: `Failed to remove worktree directory "${workspace.path}"`,
    });
  }

  await pruneGitWorktrees(projectPath);
  return ok(true);
}

/**
 * Deletes the workspace row and its derived file index only when no other session still references it.
 *
 * Sessions are deduplicated onto a single workspace row per resolved path (see
 * `ensureRepositoryWorkspace`), so every session in a project can share the project-root
 * workspace, and spawned sessions share their source's. Deleting it unconditionally orphaned the
 * siblings, whose `workspaceId` then pointed at a missing row — surfacing later as `Workspace not found`
 * during bootstrap. `excludeSessionId` is the session being deleted; its row still exists at this
 * point, so it must not count as a reference.
 */
export async function deleteWorkspaceIfUnused(
  workspaceId: string,
  excludeSessionId: string
): Promise<void> {
  const [wsRow] = await db
    .select({ id: workspaces.id, kind: workspaces.kind, projectId: workspaces.projectId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (wsRow?.kind === 'project-root') return;
  // #7341 挂在项目下的文件夹是项目的一部分,不是哪条会话的附属:最后一条会话删了,它照样挂在项目里。
  if (wsRow?.projectId) return;

  const [sibling] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), ne(sessions.id, excludeSessionId)))
    .limit(1);
  if (sibling) return;

  try {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    log.warn('deleteWorkspaceIfUnused: 已删除工作区行', {
      workspaceId,
      kind: wsRow?.kind ?? null,
      deletedForSessionId: excludeSessionId,
    });
    void workspaceFileIndexService.deleteIndex(workspaceId);
  } catch (e) {
    log.warn('deleteWorkspaceIfUnused: workspace row deletion failed', {
      workspaceId,
      error: String(e),
    });
  }
}
