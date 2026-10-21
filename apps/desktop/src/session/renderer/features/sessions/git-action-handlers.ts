import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import type { GitWorktreeStore } from '@renderer/features/sessions/stores/git-worktree-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { formatPushErrorDetail } from './utils';
import { vcsFailureText } from './vcs-failure';

// 这些是命令面板/快捷键也会触发的**非 React** 入口，所以走 translateSessionMessage 而不是 hook。
// 它们只产出 toast —— 一次性、当场读当前 locale 即可，不需要在语言切换后回头重译。
// #4891:失败原因走 vcsFailureText —— 工具自己的话给用户，内部 error type 只进日志。

export async function runGitFetch(repository: GitRepositoryStore) {
  const result = await repository.fetchRemote();
  if (!result.success) {
    toast({
      title: vcsFailureText('fetch', result.error, translateSessionMessage, 'git.fetchRemoteFailed'),
      variant: 'destructive',
    });
  }
  return result;
}

export async function runGitPull(git: GitWorktreeStore) {
  const result = await git.pull();
  if (!result.success) {
    toast({
      title: vcsFailureText('pull', result.error, translateSessionMessage, 'git.pullFailed'),
      variant: 'destructive',
    });
  }
  return result;
}

export async function runGitPush(git: GitWorktreeStore) {
  const result = await git.push();
  if (!result.success) {
    toast({
      title: translateSessionMessage('git.pushFailed', {
        detail: formatPushErrorDetail(result.error, translateSessionMessage)
      }),
      variant: 'destructive',
    });
  }
  return result;
}

export async function runGitPublishBranch({
  repository,
  branchName,
  workspaceId,
}: {
  repository: GitRepositoryStore;
  branchName: string | null | undefined;
  workspaceId?: string;
}) {
  if (!branchName) {
    toast({
      title: translateSessionMessage('git.publishBranchFailed', {
        detail: translateSessionMessage('git.noBranchCheckedOut')
      }),
      variant: 'destructive',
    });
    return undefined;
  }

  const result = await repository.publishBranch(branchName, workspaceId);
  if (!result.success) {
    toast({
      title: translateSessionMessage('git.publishBranchFailed', {
        detail: formatPushErrorDetail(result.error, translateSessionMessage)
      }),
      variant: 'destructive',
    });
  }
  return result;
}
