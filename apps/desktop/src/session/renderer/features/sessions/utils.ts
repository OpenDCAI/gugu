import type { FetchError, PushError } from '@gugu/session-core/git';
import { match } from 'ts-pattern';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { GitFetchFailure } from './stores/session-failure';

type PushLikeError = PushError | { type: string; message?: string };

/**
 * 这几个 formatter 把**已知 git 错误**的稳定语义映射成用户能读的一句话，所以它们需要一份
 * translator。它们保持纯函数：由调用方（React 组件 / 持有 translator 的 store）传进来，
 * 不在这里读全局 locale。未匹配到已知形态时原样返回底层 message —— 那是诊断数据，不改写。
 */
type Translate = ReturnType<typeof useSessionMessages>['translate'];

// `formatErrorType`（只取 `error.type`）已删：它把 `git_error` / `not-repository` 这类内部标签
// 当作用户文案的 `{detail}` 端出去，同时把 stderr 整个丢掉。失败原因现在走 `./vcs-failure.ts`。

export function splitPath(filePath: string) {
  const parts = filePath.split('/');
  const filename = parts.pop() || filePath;
  const directory = parts.length > 0 ? parts.join('/') : '';
  return { filename, directory };
}

/** 纯语义：把已知 fetch 失败映射成领域 kind。不成句、不读 locale、不认识 catalog。 */
export function fetchErrorFailure(error: FetchError): GitFetchFailure {
  return match<FetchError, GitFetchFailure>(error)
    .with({ type: 'no_remote' }, () => ({ kind: 'no-remote' }))
    .with({ type: 'auth_failed' }, (e): GitFetchFailure =>
      e.message.toLowerCase().includes('github.com')
        ? { kind: 'github-auth-failed' }
        : { kind: 'git-auth-failed' }
    )
    .with({ type: 'network_error' }, () => ({ kind: 'network-error' }))
    .with({ type: 'remote_not_found' }, () => ({ kind: 'remote-not-found' }))
    .with({ type: 'git_error' }, (e) => ({ kind: 'unexpected' as const, detail: e.message }))
    .exhaustive();
}

/** 渲染边界：领域 kind → catalog 外壳。 */
export function describeGitFetchFailure(failure: GitFetchFailure, translate: Translate): string {
  const machine = translate('git.machineLocal');
  switch (failure.kind) {
    case 'no-remote':
      return translate('git.noRemoteConfigured');
    case 'github-auth-failed':
      return translate('git.githubAuthFailed', { machine });
    case 'git-auth-failed':
      return translate('git.gitAuthFailed', { machine });
    case 'network-error':
      return translate('git.networkError');
    case 'remote-not-found':
      return translate('git.remoteNotFound');
    case 'unexpected':
      // 未知失败：外壳可翻，底层 message 逐字带出（spec: 未知错误保留可诊断详情）。
      return failure.detail
        ? translate('git.fetchUnexpectedDetail', { detail: failure.detail })
        : translate('git.fetchUnexpected');
  }
}

export function formatFetchErrorDetail(error: FetchError, translate: Translate): string {
  return describeGitFetchFailure(fetchErrorFailure(error), translate);
}

export function formatPushErrorDetail(error: PushLikeError, translate: Translate): string {
  const message = 'message' in error ? (error.message ?? error.type) : error.type;
  const normalized = message.toLowerCase();

  if (
    normalized.includes('github.com') &&
    (normalized.includes('repository not found') ||
      (normalized.includes('fatal: repository') && normalized.includes('not found')) ||
      normalized.includes('not found'))
  ) {
    return translate('git.githubRepositoryAccess');
  }

  if (
    normalized.includes('github.com') &&
    (normalized.includes('could not read username') ||
      normalized.includes('terminal prompts disabled') ||
      normalized.includes('authentication failed') ||
      normalized.includes('permission denied'))
  ) {
    return translate('git.githubAuthentication');
  }

  return message;
}
