import { gitErrorMessage, type DiffTarget, type GitObjectRef } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import { resolveWorkspace } from '@main/core/projects/utils';
import { log } from '@main/lib/logger';
import type {
  GitWorktreeCommitResult,
  GitWorktreeMutationResult,
  GitWorktreeSnapshotResult,
} from '@shared/core/git/rpc';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { revertWorktreeFiles, stageWorktreeFiles, unstageWorktreeFiles } from './mutations';

export const gitWorktreeController = createRPCController({
  getWorktreeSnapshot: async (
    projectId: string,
    workspaceId: string
  ): Promise<GitWorktreeSnapshotResult> => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' });
      return ok(await workspace.gitWorktree.getSnapshot());
    } catch (error) {
      log.error('gitCtrl.getWorktreeSnapshot failed', { projectId, workspaceId, error });
      return err({ type: 'git_error', message: gitErrorMessage(error) });
    }
  },

  getChangedFiles: async (projectId: string, workspaceId: string, base: DiffTarget) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ changes: await workspace.gitWorktree.getChangedFiles(base) });
    } catch (error) {
      log.error('gitCtrl.getChangedFiles failed', { projectId, workspaceId, base, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getFileAtRef: async (projectId: string, workspaceId: string, filePath: string, ref: string) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ content: await workspace.gitWorktree.getFileAtRef(filePath, ref) });
    } catch (error) {
      log.error('gitCtrl.getFileAtRef failed', { projectId, workspaceId, filePath, ref, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getFileAtIndex: async (projectId: string, workspaceId: string, filePath: string) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ content: await workspace.gitWorktree.getFileAtIndex(filePath) });
    } catch (error) {
      log.error('gitCtrl.getFileAtIndex failed', { projectId, workspaceId, filePath, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getImageAtRef: async (projectId: string, workspaceId: string, filePath: string, ref: string) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ result: await workspace.gitWorktree.getImageAtRef(filePath, ref) });
    } catch (error) {
      log.error('gitCtrl.getImageAtRef failed', { projectId, workspaceId, filePath, ref, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getImageAtIndex: async (projectId: string, workspaceId: string, filePath: string) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ result: await workspace.gitWorktree.getImageAtIndex(filePath) });
    } catch (error) {
      log.error('gitCtrl.getImageAtIndex failed', { projectId, workspaceId, filePath, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  stageFiles: (
    projectId: string,
    workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return stageWorktreeFiles(projectId, workspaceId, filePaths);
  },

  stageAllFiles: async (
    projectId: string,
    workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      const result = await workspace.gitWorktree.stageAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.stageAllFiles failed', { projectId, workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  unstageFiles: (
    projectId: string,
    workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return unstageWorktreeFiles(projectId, workspaceId, filePaths);
  },

  unstageAllFiles: async (
    projectId: string,
    workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      const result = await workspace.gitWorktree.unstageAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.unstageAllFiles failed', { projectId, workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  revertFiles: (
    projectId: string,
    workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return revertWorktreeFiles(projectId, workspaceId, filePaths);
  },

  revertAllFiles: async (
    projectId: string,
    workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      const result = await workspace.gitWorktree.revertAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.revertAllFiles failed', { projectId, workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  commit: async (
    projectId: string,
    workspaceId: string,
    message: string
  ): Promise<GitWorktreeCommitResult> => {
    const workspace = resolveWorkspace(projectId, workspaceId);
    if (!workspace) return err({ type: 'not_found' });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' });
    return workspace.gitWorktree.commit(message);
  },

  push: async (projectId: string, workspaceId: string, remote: string) => {
    const workspace = resolveWorkspace(projectId, workspaceId);
    if (!workspace) return err({ type: 'not_found' });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' });
    const result = await workspace.gitWorktree.push(remote);
    return result;
  },

  pull: async (projectId: string, workspaceId: string) => {
    const workspace = resolveWorkspace(projectId, workspaceId);
    if (!workspace) return err({ type: 'not_found' as const });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
    const result = await workspace.gitWorktree.pull();
    return result;
  },

  getLog: async (
    projectId: string,
    workspaceId: string,
    maxCount?: number,
    skip?: number,
    knownAheadCount?: number,
    remote?: string,
    base?: GitObjectRef,
    head?: GitObjectRef
  ) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      const result = await workspace.gitWorktree.getLog({
        maxCount,
        skip,
        knownAheadCount,
        preferredRemote: remote,
        base,
        head,
      });
      return ok({ commits: result.commits, aheadCount: result.aheadCount });
    } catch (error) {
      log.error('gitCtrl.getLog failed', { projectId, workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getCommitFiles: async (projectId: string, workspaceId: string, commitHash: string) => {
    try {
      const workspace = resolveWorkspace(projectId, workspaceId);
      if (!workspace) return err({ type: 'not_found' as const });
      // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
      if (!workspace.gitWorktree) return err({ type: 'not_found' as const });
      return ok({ files: await workspace.gitWorktree.getCommitFiles(commitHash) });
    } catch (error) {
      log.error('gitCtrl.getCommitFiles failed', { projectId, workspaceId, commitHash, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },
});
