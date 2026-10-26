import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { rpcOn } from '@renderer/lib/ipc';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';

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
    queryKey: host.remote || host.assistantPanelExpected ? [...GITHUB_ACCOUNTS_QUERY_KEY, host.key] : GITHUB_ACCOUNTS_QUERY_KEY,
    queryFn: () => host.github.listAccounts(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: host.assistantPanelExpected ? !!host.assistantPanel : host.remote?.online !== false,
    ...(host.remote ? { retry: false } : {}),
  });
}

export function useImportGitHubCliAccounts() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async () => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.importCliAccounts();
      if (result.success && result.importedAccountIds.length) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', section: 'accounts', id: 'github', deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useGitHubDeviceFlowAuth() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async () => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.auth();
      if (result.success) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', section: 'accounts', id: 'github', deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSettled: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useSetDefaultGitHubAccount() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.setDefaultAccount(accountId);
      if (result.success) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'edited', section: 'accounts', id: `github:${accountId}`, deviceId: host.remote?.deviceId,
          after: { isDefault: true } }, ownerId);
      return result;
    },
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useRemoveGitHubAccount() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.removeAccount(accountId);
      if (result.success) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'removed', section: 'accounts', id: `github:${accountId}`, deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}
