import {
  type GitChange,
  type GitHeadModel,
  type GitStatusModel,
  type GitWorktreeSnapshot,
} from '@gugu/session-core/git';
import { err, ok, type Result } from '@gugu/session-shared';
import { computed, makeObservable, observable, runInAction } from 'mobx';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import {
  bindMirror,
  coalesce,
  ModelMirror,
  OptimisticModel,
  type MirrorBinding,
  type MirrorBindingStatus,
} from '@renderer/lib/stores/live';
import { gitWorktreeUpdateChannel } from '@shared/core/git/events';
import type { GitWorktreeMutationResult, GitWorktreeSnapshotError } from '@shared/core/git/rpc';
import {
  commitOptimistically,
  discardAllOptimistically,
  discardFilesOptimistically,
  stageAllOptimistically,
  stageFilesOptimistically,
  unstageAllOptimistically,
  unstageFilesOptimistically,
} from './git-status-optimistic-updates';
import { workspaceEvents, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

const TOO_MANY_FILES_MSG = 'Too many files changed to display';
/** 工作目录不是 git 仓库时状态里的那个原因码(别的机器上的会话由 remote-git-adapter 报)。 */
export const NOT_REPOSITORY = 'not-repository';

export class GitWorktreeStore {
  private readonly status = new ModelMirror<GitStatusModel>();
  private readonly head = new ModelMirror<GitHeadModel>();
  private readonly optimisticStatus = new OptimisticModel<GitStatusModel>(this.status);
  private readonly bindings: MirrorBinding[];
  private started = false;
  private syncError: string | null = null;

  constructor(
    private readonly projectId: string,
    private readonly workspaceId: string,
    /** 仓库层面的读数(分支在不在远端、推到哪个 remote);别的机器上的会话没有这一层 = null。 */
    private readonly gitRepositoryStore: GitRepositoryStore | null
  ) {
    const snapshot = coalesce(
      async (): Promise<Result<GitWorktreeSnapshot, GitWorktreeSnapshotError>> => {
        const result = await workspaceRpc(this.projectId).gitWorktree.getWorktreeSnapshot(
          this.projectId,
          this.workspaceId
        );
        if (!result.success) return err(result.error);
        runInAction(() => {
          this.syncError = null;
        });
        return ok(result.data);
      }
    );
    const onError = (error: GitWorktreeSnapshotError) => {
      runInAction(() => {
        this.syncError = error.type === 'git_error' ? error.message : error.type;
      });
    };
    this.bindings = [
      bindMirror<GitStatusModel, GitWorktreeSnapshotError>({
        mirror: this.status,
        subscribe: (push) =>
          workspaceEvents.on(gitWorktreeUpdateChannel, (payload) => {
            if (payload.workspaceId === this.workspaceId && payload.update.kind === 'status') {
              push({
                value: payload.update.model,
                sequence: payload.update.sequence,
                generation: payload.update.generation,
              });
            }
          }),
        snapshot: async () => {
          const result = await snapshot();
          return result.success ? ok(result.data.status) : err(result.error);
        },
        onError,
      }),
      bindMirror<GitHeadModel, GitWorktreeSnapshotError>({
        mirror: this.head,
        subscribe: (push) =>
          workspaceEvents.on(gitWorktreeUpdateChannel, (payload) => {
            if (payload.workspaceId === this.workspaceId && payload.update.kind === 'head') {
              push({
                value: payload.update.model,
                sequence: payload.update.sequence,
                generation: payload.update.generation,
              });
            }
          }),
        snapshot: async () => {
          const result = await snapshot();
          return result.success ? ok(result.data.head) : err(result.error);
        },
        onError,
      }),
    ];

    makeObservable<this, 'effectiveStatus' | 'syncError'>(this, {
      syncError: observable,
      fileChanges: computed,
      stagedFileChanges: computed,
      unstagedFileChanges: computed,
      totalLinesAdded: computed,
      totalLinesDeleted: computed,
      hasData: computed,
      problem: computed,
      isLoading: computed,
      error: computed,
      isBranchPublished: computed,
      aheadCount: computed,
      behindCount: computed,
      branchName: computed,
      headOid: computed,
      headKind: computed,
      headDisplay: computed,
      effectiveStatus: computed,
      syncStatus: computed,
      statusRevision: computed,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const binding of this.bindings) binding.start();
  }

  async resync(): Promise<void> {
    return Promise.all(this.bindings.map((binding) => binding.resync())).then(() => undefined);
  }

  dispose(): void {
    for (const binding of this.bindings) binding.dispose();
    this.started = false;
    this.optimisticStatus.dispose();
    this.status.dispose();
    this.head.dispose();
  }

  get statusRevision(): number {
    return Math.max(this.status.sequence, this.head.sequence);
  }

  get syncStatus(): MirrorBindingStatus {
    const statuses = this.bindings.map((binding) => binding.status);
    for (const status of ['error', 'syncing', 'idle'] as const) {
      if (statuses.includes(status)) return status;
    }
    return 'live';
  }

  get fileChanges(): GitChange[] {
    const map = new Map<string, { staged?: GitChange; unstaged?: GitChange }>();
    for (const change of this.stagedFileChanges) {
      map.set(change.path, { ...map.get(change.path), staged: change });
    }
    for (const change of this.unstagedFileChanges) {
      map.set(change.path, { ...map.get(change.path), unstaged: change });
    }
    const out: GitChange[] = [];
    for (const { staged, unstaged } of map.values()) {
      if (staged && unstaged) {
        out.push({
          path: staged.path,
          status: 'modified',
          additions: staged.additions + unstaged.additions,
          deletions: staged.deletions + unstaged.deletions,
        });
      } else if (staged) {
        out.push(staged);
      } else if (unstaged) {
        out.push(unstaged);
      }
    }
    return out;
  }

  get stagedFileChanges(): GitChange[] {
    const status = this.effectiveStatus;
    return status?.kind === 'ok' ? status.staged : [];
  }

  get unstagedFileChanges(): GitChange[] {
    const status = this.effectiveStatus;
    return status?.kind === 'ok' ? status.unstaged : [];
  }

  get totalLinesAdded(): number {
    const status = this.effectiveStatus;
    if (status?.kind !== 'ok') return 0;
    return status.stagedAdded + status.unstaged.reduce((sum, change) => sum + change.additions, 0);
  }

  get totalLinesDeleted(): number {
    const status = this.effectiveStatus;
    if (status?.kind !== 'ok') return 0;
    return (
      status.stagedDeleted + status.unstaged.reduce((sum, change) => sum + change.deletions, 0)
    );
  }

  get hasData(): boolean {
    return this.status.value !== null && this.head.value !== null;
  }

  get isLoading(): boolean {
    return !this.hasData;
  }

  get error(): string | undefined {
    const status = this.effectiveStatus;
    if (status?.kind === 'too-many-files') return TOO_MANY_FILES_MSG;
    if (status?.kind === 'error') return status.message;
    if (!this.hasData && this.syncStatus === 'error') {
      return this.syncError ?? 'Failed to load git status';
    }
    return undefined;
  }

  /**
   * 审阅页画不出改动清单的原因(可观察):改动太多 / 工作目录不是 git 仓库 / 读失败(带原话,可重试)。
   * 还在读 = null(界面画加载态)。
   */
  get problem(): { kind: 'too-many-files' } | { kind: 'not-repository' } | { kind: 'failed'; message: string } | null {
    const status = this.effectiveStatus;
    if (status?.kind === 'too-many-files') return { kind: 'too-many-files' };
    if (status?.kind === 'error') {
      return status.message === NOT_REPOSITORY ? { kind: 'not-repository' } : { kind: 'failed', message: status.message };
    }
    if (!this.hasData && this.syncStatus === 'error') {
      // 宿主对没有 git 工作树的工作区(#2358 非 git 项目、没选文件夹时的隐藏任务工作区)答 `not_found`:
      // 说「不是 git 仓库」,❌ 把原因码 not_found 原样摆给人看。
      if (this.syncError === 'not_found') return { kind: 'not-repository' };
      return { kind: 'failed', message: this.syncError ?? '' };
    }
    return null;
  }

  get branchName(): string | null {
    const head = this.head.value;
    if (!head || head.kind === 'detached') return null;
    return head.name;
  }

  get headOid(): string | null {
    const head = this.head.value;
    return head?.kind === 'branch' || head?.kind === 'detached' ? head.oid : null;
  }

  get headKind(): 'branch' | 'detached' | 'unborn' {
    return this.head.value?.kind ?? 'branch';
  }

  get headDisplay(): string | null {
    const head = this.head.value;
    if (!head) return null;
    return head.kind === 'detached' ? head.shortHash : head.name;
  }

  get isBranchPublished(): boolean {
    const name = this.branchName;
    return name ? (this.gitRepositoryStore?.isBranchOnRemote(name) ?? false) : false;
  }

  get aheadCount(): number {
    const name = this.branchName;
    return name ? (this.gitRepositoryStore?.getBranchDivergence(name)?.ahead ?? 0) : 0;
  }

  get behindCount(): number {
    const name = this.branchName;
    return name ? (this.gitRepositoryStore?.getBranchDivergence(name)?.behind ?? 0) : 0;
  }

  async stageFiles(paths: string[]): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => stageFilesOptimistically(model, paths),
      () => workspaceRpc(this.projectId).gitWorktree.stageFiles(this.projectId, this.workspaceId, paths),
      (data) => data.sequences.status
    );
    return result;
  }

  async stageAllFiles(): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => stageAllOptimistically(model),
      () => workspaceRpc(this.projectId).gitWorktree.stageAllFiles(this.projectId, this.workspaceId),
      (data) => data.sequences.status
    );
    return result;
  }

  async unstageFiles(paths: string[]): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => unstageFilesOptimistically(model, paths),
      () => workspaceRpc(this.projectId).gitWorktree.unstageFiles(this.projectId, this.workspaceId, paths),
      (data) => data.sequences.status
    );
    return result;
  }

  async unstageAllFiles(): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => unstageAllOptimistically(model),
      () => workspaceRpc(this.projectId).gitWorktree.unstageAllFiles(this.projectId, this.workspaceId),
      (data) => data.sequences.status
    );
    return result;
  }

  async discardFiles(paths: string[]): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => discardFilesOptimistically(model, paths),
      () => workspaceRpc(this.projectId).gitWorktree.revertFiles(this.projectId, this.workspaceId, paths),
      (data) => data.sequences.status
    );
    return result;
  }

  async discardAllFiles(): Promise<GitWorktreeMutationResult> {
    const result = await this.optimisticStatus.run(
      (model) => discardAllOptimistically(model),
      () => workspaceRpc(this.projectId).gitWorktree.revertAllFiles(this.projectId, this.workspaceId),
      (data) => data.sequences.status
    );
    return result;
  }

  async commit(message: string) {
    const result = await this.optimisticStatus.run(
      (model) => commitOptimistically(model),
      () => workspaceRpc(this.projectId).gitWorktree.commit(this.projectId, this.workspaceId, message),
      (data) => data.sequences.status
    );
    if (result.success) return ok();
    return err(result.error);
  }

  async push() {
    // 别的机器上的会话由那台机器按它自己的上游推(remote 名在那边定)。
    const remote = this.gitRepositoryStore?.pushRemote.name ?? 'origin';
    const result = await workspaceRpc(this.projectId).gitWorktree.push(this.projectId, this.workspaceId, remote);
    if (result.success) return ok();
    return err(result.error);
  }

  async pull() {
    const result = await workspaceRpc(this.projectId).gitWorktree.pull(this.projectId, this.workspaceId);
    if (result.success) return ok();
    return err(result.error);
  }

  private get effectiveStatus(): GitStatusModel | null {
    return this.optimisticStatus.value;
  }
}
