import { useQuery } from '@tanstack/react-query';
import { isTooOld, useLibraryHost } from '@renderer/features/library/library-host';
import type { rpc } from '@renderer/lib/ipc';
import { ISSUE_CONNECTION_STATUS_QUERY_KEY } from './integrations-provider';

export type IntegrationAccountSummary = Awaited<ReturnType<typeof rpc.integrations.accounts>>[number];
export type IntegrationAccountCheck = Awaited<ReturnType<typeof rpc.integrations.checkAccounts>>[number];

/**
 * #7240 一家集成存着的每个账号,和逐个查出来的连接状态(资源库详情的「%s 连接」)。
 * 缓存键挂在连接状态那一串下面:连上 / 断开 / 重新授权之后随它一起重取。
 * 那台机器比这个功能老(`unknown_method`)⇒ `supported: false`,详情照旧按单账号画。
 */
export function useIntegrationAccounts(
  integrationId: string,
  configured: boolean,
  /** false = 只要账号清单(列表上的「N 个账号」):❌ 为数个数逐个登录对方服务。 */
  { check = true }: { check?: boolean } = {}
) {
  const host = useLibraryHost();
  const enabled = configured && (host.assistantPanelExpected ? !!host.assistantPanel : host.remote?.online !== false);
  const base = [...ISSUE_CONNECTION_STATUS_QUERY_KEY, host.key, 'accounts', integrationId] as const;

  const accounts = useQuery({
    queryKey: base,
    queryFn: async () => {
      try {
        return { supported: true as const, accounts: await host.integrations.accounts(integrationId) };
      } catch (error) {
        if (isTooOld(error)) return { supported: false as const, accounts: [] };
        throw error;
      }
    },
    enabled,
    staleTime: 30_000,
    ...(host.remote ? { retry: false } : {}),
  });

  const supported = accounts.data?.supported === true;
  const checks = useQuery({
    queryKey: [...base, 'checks'],
    queryFn: () => host.integrations.checkAccounts(integrationId),
    enabled: check && enabled && supported && (accounts.data?.accounts.length ?? 0) > 0,
    staleTime: 30_000,
    ...(host.remote ? { retry: false } : {}),
  });

  return {
    supported,
    accounts: accounts.data?.accounts ?? [],
    isLoading: accounts.isLoading,
    error: accounts.error,
    retry: () => void accounts.refetch(),
    checks: new Map((checks.data ?? []).map((check) => [check.accountId, check])),
    isChecking: checks.isFetching,
  };
}
