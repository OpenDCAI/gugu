import type { GitChange } from '@gugu/session-core/git';
import { makeAutoObservable } from 'mobx';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import { events, rpc } from '@renderer/lib/ipc';
import { Resource } from '@renderer/lib/stores/resource';
import { gitRepoUpdateChannel, gitWorktreeUpdateChannel } from '@shared/core/git/events';
import { commitRef, mergeBaseRange } from '@shared/core/git/utils';
import {
  isForkPr,
  pullRequestErrorMessage,
  selectCurrentPr,
  type PullRequest,
  type PullRequestMergeOptions,
} from '@shared/core/pull-requests/pull-requests';
import { isRegistered, type SessionPageStore } from './session-store';
import { workspaceEvents, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

export type MergeResult = { success: true } | { success: false; error: string };

/** Extract the numeric PR number from the identifier field (e.g. "#123" → 123). */
function prNumberFromIdentifier(identifier: string | null): number | null {
  if (!identifier) return null;
  const n = Number.parseInt(identifier.replace('#', ''), 10);
  return Number.isNaN(n) ? null : n;
}

export class PrStore {
  private readonly _prFiles = new Map<
    string,
    { resource: Resource<GitChange[]>; baseRefOid: string; headRefOid: string }
  >();

  constructor(
    private readonly projectId: string,
    private readonly workspaceId: string,
    private readonly gitRepositoryStore: GitRepositoryStore,
    private readonly sessionPageStore: SessionPageStore
  ) {
    makeAutoObservable(this);
  }

  get pullRequests(): PullRequest[] {
    if (!isRegistered(this.sessionPageStore)) return [];
    return this.sessionPageStore.prs;
  }

  get currentPr(): PullRequest | undefined {
    return selectCurrentPr(this.pullRequests);
  }

  getFiles(pr: PullRequest): Resource<GitChange[]> {
    const key = pr.url;
    const existing = this._prFiles.get(key);
    if (
      existing &&
      (existing.baseRefOid !== pr.baseRefOid || existing.headRefOid !== pr.headRefOid)
    ) {
      existing.resource.dispose();
      this._prFiles.delete(key);
    }
    if (!this._prFiles.has(key)) {
      const resource = new Resource<GitChange[]>(
        () => this._fetchPrFiles(pr),
        [
          { kind: 'poll', intervalMs: 60_000, pauseWhenHidden: true, demandGated: true },
          {
            kind: 'event',
            subscribe: (handler) => {
              const unsubHead = workspaceEvents.on(gitWorktreeUpdateChannel, (p) => {
                if (p.workspaceId === this.workspaceId && p.update.kind === 'head') handler();
              });
              const unsubRefs = events.on(gitRepoUpdateChannel, (p) => {
                if (p.projectId === this.projectId && p.update.kind === 'refs') handler();
              });
              return () => {
                unsubHead();
                unsubRefs();
              };
            },
            onEvent: 'reload',
            debounceMs: 500,
          },
        ]
      );
      resource.start();
      this._prFiles.set(key, {
        resource,
        baseRefOid: pr.baseRefOid,
        headRefOid: pr.headRefOid,
      });
    }
    return this._prFiles.get(key)!.resource;
  }

  async mergePr(id: string, options: PullRequestMergeOptions): Promise<MergeResult> {
    const pr = this.pullRequests.find((p) => p.url === id);
    if (!pr) {
      return { success: false, error: 'Pull request not found' };
    }

    const prNumber = prNumberFromIdentifier(pr.identifier);
    if (!prNumber) return { success: false, error: 'Could not determine PR number' };

    const result = await rpc.pullRequests.mergePullRequest(
      this.projectId,
      pr.repositoryUrl,
      prNumber,
      options
    );
    if (result.success) {
      return { success: true };
    }

    return { success: false, error: pullRequestErrorMessage(result.error) };
  }

  async markReadyForReview(id: string): Promise<void> {
    const pr = this.pullRequests.find((p) => p.url === id);
    if (!pr) return;
    const prNumber = prNumberFromIdentifier(pr.identifier);
    if (!prNumber) return;
    await rpc.pullRequests.markReadyForReview(this.projectId, pr.repositoryUrl, prNumber);
  }

  /**
   * Trigger a single PR refresh from GitHub. The updated PR will arrive via
   * `prUpdatedChannel` and be merged into `task.data.prs` by `ProjectSessionsStore`.
   */
  refresh(id: string): void {
    const pr = this.pullRequests.find((p) => p.url === id);
    if (!pr) return;

    const prNumber = prNumberFromIdentifier(pr.identifier);
    if (prNumber) {
      void rpc.pullRequests.refreshPullRequest(this.projectId, pr.repositoryUrl, prNumber);
    }

    // Also trigger a check-run sync — the result arrives embedded in the
    // next prUpdatedChannel event emitted by syncChecks.
    void rpc.pullRequests.syncChecks(this.projectId, pr.url, pr.headRefOid);
  }

  dispose(): void {
    for (const entry of this._prFiles.values()) entry.resource.dispose();
  }

  private async _fetchPrFiles(pr: PullRequest): Promise<GitChange[]> {
    const baseRef = commitRef(pr.baseRefOid);
    const headRef = commitRef(pr.headRefOid);
    const range = mergeBaseRange(baseRef, headRef);

    const tryRange = async (): Promise<GitChange[] | null> => {
      const result = await workspaceRpc(this.projectId).gitWorktree.getChangedFiles(
        this.projectId,
        this.workspaceId,
        range
      );
      if (!result.success) return null;
      const changes = result.data.changes;
      const expectedChangedFiles = pr.changedFiles;
      if (changes.length === 0 && expectedChangedFiles !== 0) return null;
      if (
        expectedChangedFiles != null &&
        expectedChangedFiles > 0 &&
        changes.length > expectedChangedFiles * 2
      ) {
        return null;
      }
      return changes;
    };

    const first = await tryRange();
    if (first) return first;

    await rpc.gitRepository.fetch(this.projectId, this.workspaceId);
    const prNumber = prNumberFromIdentifier(pr.identifier);
    if (prNumber) {
      await rpc.gitRepository.fetchPrForReview(
        this.projectId,
        prNumber,
        pr.headRefName,
        pr.headRepositoryUrl,
        isForkPr(pr)
      );
    }

    const retry = await tryRange();
    return retry ?? [];
  }
}

/** 审阅页读 PR 的那几样(本机 = PrStore;别的机器上的会话没有 PR 这一层 = NO_PULL_REQUESTS)。 */
export type PullRequestSource = Pick<PrStore, 'pullRequests' | 'currentPr' | 'getFiles'>;

/** 没有 PR 这一层的会话(别的机器上的):列表空着,PR 那几格不摆。 */
export const NO_PULL_REQUESTS: PullRequestSource = {
  pullRequests: [],
  currentPr: undefined,
  getFiles: () => {
    throw new Error('no pull requests on this workspace');
  },
};
