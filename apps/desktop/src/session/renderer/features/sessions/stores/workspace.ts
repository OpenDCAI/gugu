import type { ILifecycle } from '@gugu/session-shared';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import { GitWorktreeStore } from './git-worktree-store';
import { LifecycleScriptsStore } from './lifecycle-scripts';
import { wireWorkspaceNudges } from './workspace-nudges';

export class WorkspaceStore implements ILifecycle {
  readonly workspaceId: string;
  readonly path: string;
  readonly gitRepository: GitRepositoryStore;
  readonly gitWorktree: GitWorktreeStore;
  readonly lifecycleScripts: LifecycleScriptsStore;
  private readonly projectId: string;
  private stopNudges: () => void = () => {};

  constructor(
    projectId: string,
    workspaceId: string,
    path: string,
    gitRepository: GitRepositoryStore
  ) {
    this.projectId = projectId;
    this.workspaceId = workspaceId;
    this.path = path;
    this.gitRepository = gitRepository;
    this.gitWorktree = new GitWorktreeStore(projectId, workspaceId, this.gitRepository);
    this.lifecycleScripts = new LifecycleScriptsStore(projectId, workspaceId);
  }

  activate(): void {
    this.gitWorktree.start();
    this.stopNudges();
    this.stopNudges = wireWorkspaceNudges(this.projectId, this.workspaceId);
  }

  initialize(): void {
    this.activate();
  }

  dispose(): void {
    this.stopNudges();
    this.gitWorktree.dispose();
    this.lifecycleScripts.dispose();
  }
}
