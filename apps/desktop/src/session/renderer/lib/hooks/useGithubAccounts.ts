import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLibraryHost } from '@renderer/features/library/library-host';

export const GITHUB_ACCOUNTS_QUERY_KEY = ['github:accounts'] as const;
export const GITHUB_ACCOUNT_STATE_QUERY_KEY = ['github:account-state'] as const;
export const ISSUE_CONNECTION_STATUS_QUERY_KEY = ['issues:connection-status'] as const;

function invalidateGitHubAccountState(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: GITHUB_ACCOUNTS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: GITHUB_ACCOUNT_STATE_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ISSUE_CONNECTION_STATUS_QUERY_KEY });
}

/**
 * GitHub 账号是**这台机器上**连的(#6264 整个资源库都分机器):资源库选了别的机器时,列 / 连 / 设默认 / 移除
 * 都是那台机器上的;其余地方(项目设置、PR 选择器)用本机的。缓存键带机器,两份互不覆盖。
 */
export function useGitHubAccounts() {
  const host = useLibraryHost();
  return useQuery({
    queryKey: host.remote ? [...GITHUB_ACCOUNTS_QUERY_KEY, host.key] : GITHUB_ACCOUNTS_QUERY_KEY,
    queryFn: () => host.github.listAccounts(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: host.remote?.online !== false,
    ...(host.remote ? { retry: false } : {}),
  });
}

export function useImportGitHubCliAccounts() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: () => host.github.importCliAccounts(),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useGitHubDeviceFlowAuth() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: () => host.github.auth(),
    onSettled: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useSetDefaultGitHubAccount() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: (accountId: string) => host.github.setDefaultAccount(accountId),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useRemoveGitHubAccount() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: (accountId: string) => host.github.removeAccount(accountId),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}
