import { connectionReadOptions } from '@/components/connections/connection-read-policy';
import { useConnectionReadNotice } from '@/components/connections/useConnectionReadNotice';
import { connectionNeedsConfirmation } from '@/components/connections/connection-application-status';
import { CONNECTIONS_CHANGED, peekOwnerConnectionMetadata,ownerConnectionMetadataView } from '@/components/connections/owner-connection-metadata';
import { builtinConnectionCatalog } from '@/components/connections/builtin-connection-catalog';
import type { ConnectionMetadataSnapshot } from '@/components/connections/connection-metadata';
import { peekAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations';
import { EMPTY_INTEGRATION_SUMMARIES,useAssistantIntegrationSummaries } from '@/components/assistant/useAssistantIntegrationSummaries';
import { isAssistantPanelReadRetryable, retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead';
import { ASSISTANT_PANEL_CHANGED } from '@/components/assistant/assistant-panel-events';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { registerIssueMentionIcons } from '@renderer/lib/chat/chat-mention-provider';
import { rpcOn, type rpc } from '@renderer/lib/ipc';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';
import type { ConnectionStatus } from '@shared/issue-providers';
import {
  getSessionLocaleSnapshot,
  subscribeSessionLocale,
  translateSessionMessage,
} from '@renderer/localization/locale-store';
import { integrationErrorText } from './integration-display';
import { prepareThenStartCliLogin } from './cli-tool-prepare';
import type { IntegrationFormInput } from './types';

export const ISSUE_CONNECTION_STATUS_QUERY_KEY = ['issues:connection-status'] as const;
export const INTEGRATIONS_LIST_QUERY_KEY = ['integrations:list'] as const;

export type IntegrationMetadata = Awaited<ReturnType<typeof rpc.integrations.list>>[number] & { metadataOnly?: true; summaryNameMissing?: boolean; catalogVersion?: string };
export type CliLoginStartResult = Awaited<ReturnType<typeof rpc.integrations.cliLoginStart>>;
export type CliLoginWaitResult = Awaited<ReturnType<typeof rpc.integrations.cliLoginWait>>;

type ConnectionStatusByIntegration = Partial<Record<string, ConnectionStatus>>;

type ConnectionMutationResult = { success: true } | { success: false; error: string };
type RawConnectionMutationResult = { success: boolean; error?: string; errorType?: ConnectionStatus['errorType'] };

type IntegrationsContextValue = {
  integrations: IntegrationMetadata[];
  connectionOperations: ConnectionMetadataSnapshot['application'];
  integrationById: Partial<Record<string, IntegrationMetadata>>;
  connectionStatus: ConnectionStatusByIntegration;
  checkedConnections: ConnectionStatusByIntegration;
  connectionCheckError: unknown;
  hasConfiguredConnections: boolean;
  configuredConnectionsError: unknown;
  configuredConnections: Partial<Record<string, boolean>>;
  isCheckingConfiguredConnections: boolean;
  isCheckingConnections: boolean;
  reloadConnections: () => void;
  connectIntegration: (
    integrationId: string,
    input: IntegrationFormInput,
    /** #7240「编辑凭据」:改哪个已存账号(留空的授权码沿用存着的)。 */
    editAccountId?: string
  ) => Promise<ConnectionMutationResult>;
  /** `accountId`(#7240):多账号里只断开这一个;不给 = 整家断开。 */
  disconnectIntegration: (integrationId: string, accountId?: string) => Promise<ConnectionMutationResult>;
  /** Browser authorization (`mcp-oauth`); settles when the user approves, denies or cancels. */
  authorizeIntegration: (integrationId: string) => Promise<ConnectionMutationResult>;
  cancelIntegrationAuthorization: (integrationId: string) => void;
  /** #7210 官方命令行:装工具、起它自带的登录,回给人看的授权链接 / 二维码。 */
  startCliLogin: (integrationId: string) => Promise<CliLoginStartResult>;
  /** 等那次登录落定;每问最多二十来秒,`pending` 就再问。落定后刷新连接状态。 */
  waitCliLogin: (integrationId: string) => Promise<CliLoginWaitResult>;
  readCliProgress?: (integrationId: string) => ReturnType<typeof rpc.integrations.cliLoginProgress>;
  isIntegrationMutating: (integrationId: string) => boolean;
  /** 读清单的错误与有没有读到(资源库看别的机器时,页面据此说那台机器怎么了)。 */
  listError: unknown;
  hasList: boolean;
  reloadList: () => void;
};

const IntegrationsContext = createContext<IntegrationsContextValue | null>(null);

function defaultConnectionStatuses(
  integrations: IntegrationMetadata[]
): ConnectionStatusByIntegration {
  return Object.fromEntries(
    integrations.map((integration) => [
      integration.id,
      { connected: false, capabilities: integration.capabilities },
    ])
  );
}

/**
 * 集成是**这台机器上**连的(凭据存在这台机器的库里,#6264 整个资源库都分机器)。应用根上那一份问本机
 * (聊天里的 @issue 用它);资源库选了别的机器时,资源库里另挂一份,问的是那台机器(`useLibraryHost`)。
 * 缓存键带机器,两份互不覆盖。
 */
export function IntegrationsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const api = host.integrations;
  const metadata = host.connectionMetadata ?? host.assistantPanel;
  const metadataExpected = host.connectionMetadataExpected ?? host.assistantPanelExpected;
  useEffect(() => {
    if (!metadataExpected) return;
    const refresh = () => { void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(host.key) }); };
    window.addEventListener(ASSISTANT_PANEL_CHANGED,refresh);
    window.addEventListener(CONNECTIONS_CHANGED,refresh);
    return () => { window.removeEventListener(ASSISTANT_PANEL_CHANGED,refresh); window.removeEventListener(CONNECTIONS_CHANGED,refresh); };
  },[metadataExpected,host.key,queryClient]);
  const remote = !!host.remote;
  const statusKey = useMemo(() => [...ISSUE_CONNECTION_STATUS_QUERY_KEY, host.key] as const, [host.key]);
  const [mutatingIntegrationIds, setMutatingIntegrationIds] = useState<Set<string>>(
    () => new Set()
  );

  // 那台机器离线就不问(问不到,只会挂满超时)。
  const enabled = metadataExpected ? !!metadata || !!host.connectionMetadataError || !!host.assistantPanelError : host.remote?.online !== false;
  // 插件的中英两份由那台机器的主进程按这台桌面的界面语言解析成字符串;换语言重取。
  const locale = useSyncExternalStore(subscribeSessionLocale, () => getSessionLocaleSnapshot().resolvedLocale);
  const initialMetadata = () => host.connectionMetadata ? peekOwnerConnectionMetadata(host.connectionMetadata,locale) : peekAssistantPanelIntegrations(host.assistantPanel,locale);
  const { data: ownerSnapshot,failureCount: ownerReadFailures } = useQuery({
    queryKey: ['connections:snapshot', host.key], queryFn: () => host.connectionMetadata!.snapshot(),
    initialData: () => host.connectionMetadata?.peekSnapshot?.(), enabled: !!host.connectionMetadata,
    staleTime: Infinity, refetchOnWindowFocus: true, ...connectionReadOptions,
    refetchInterval: query => query.state.data?.application.some(connectionNeedsConfirmation) ? 3000 : 15_000,
  });
  useConnectionReadNotice(`snapshot:${host.key}`,!!ownerSnapshot,host.connectionMetadataExpected ? ownerReadFailures : 0);
  const {
    data: listData,
    error: listError,
    refetch: refetchList,
  } = useQuery({
    queryKey: [...INTEGRATIONS_LIST_QUERY_KEY, host.key, locale],
    queryFn: () => api.list(locale),
    initialData: () => host.connectionMetadataExpected ? builtinConnectionCatalog(locale) : initialMetadata()?.items,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
    refetchInterval: query => metadataExpected && isAssistantPanelReadRetryable(query.state.error) ? 30_000 : false,
    ...(host.connectionMetadataExpected ? connectionReadOptions : metadataExpected ? { retry: retryAssistantPanelRead,refetchOnWindowFocus: (query: { state: { error: unknown } }) => isAssistantPanelReadRetryable(query.state.error) } : remote ? { retry: false } : {}),
  });

  const ownerItems = useMemo(() => ownerSnapshot ? ownerConnectionMetadataView(ownerSnapshot,locale).items : undefined,[ownerSnapshot,locale]);
  const integrations = useAssistantIntegrationSummaries(metadata,ownerItems ?? listData ?? EMPTY_INTEGRATION_SUMMARIES,locale);

  useEffect(() => {
    // @issue 的图标是聊天里用的,聊天只跟本机那一份走。
    if (!remote) registerIssueMentionIcons(integrations);
  }, [integrations, remote]);

  const { data: statusData, error: connectionReadError, isFetching: isCheckingConnections } = useQuery({
    queryKey: statusKey,
    queryFn: () => api.checkAllConnections(),
    initialData: () => initialMetadata()?.statuses,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled,
    refetchInterval: query => metadataExpected && isAssistantPanelReadRetryable(query.state.error) ? 30_000 : false,
    ...(host.connectionMetadataExpected ? connectionReadOptions : metadataExpected ? { retry: retryAssistantPanelRead,refetchOnWindowFocus: (query: { state: { error: unknown } }) => isAssistantPanelReadRetryable(query.state.error) } : remote ? { retry: false } : {}),
  });

  const { data: configuredData, error: configuredConnectionsError, isFetching: isCheckingConfiguredConnections } =
    useQuery({
      queryKey: [...statusKey, 'configured'],
      queryFn: () => api.checkConfiguredConnections(),
      initialData: () => initialMetadata()?.configured,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      enabled,
    refetchInterval: query => metadataExpected && isAssistantPanelReadRetryable(query.state.error) ? 30_000 : false,
      ...(host.connectionMetadataExpected ? connectionReadOptions : metadataExpected ? { retry: retryAssistantPanelRead,refetchOnWindowFocus: (query: { state: { error: unknown } }) => isAssistantPanelReadRetryable(query.state.error) } : remote ? { retry: false } : {}),
    });
  const configuredConnections = configuredData ?? {};

  const invalidateStatuses = useCallback(() => {
    // A completed authorization invalidates both the file snapshot and all visible consumers.
    // The host's subsequent publication uses the same event when authorization finishes elsewhere.
    metadata?.invalidate();
    void queryClient.invalidateQueries({ queryKey: statusKey });
  }, [queryClient, statusKey, metadata]);

  const setIntegrationMutating = useCallback((integrationId: string, isMutating: boolean) => {
    setMutatingIntegrationIds((current) => {
      if (current.has(integrationId) === isMutating) return current;

      const next = new Set(current);
      if (isMutating) {
        next.add(integrationId);
      } else {
        next.delete(integrationId);
      }
      return next;
    });
  }, []);

  const runConnectionMutation = useCallback(
    async (
      integrationId: string,
      mutation: () => Promise<RawConnectionMutationResult>,
      fallbackError: string,
      change: { operation: 'saved' | 'removed'; id?: string } = { operation: 'saved' },
    ): Promise<ConnectionMutationResult> => {
      const ownerId = cachedDevicesAccount();
      setIntegrationMutating(integrationId, true);
      try {
        const result = await mutation();
        if (!result.success) {
          const name = integrations.find((integration) => integration.id === integrationId)?.name ?? integrationId;
          return { success: false, error: integrationErrorText(translateSessionMessage, name, result) || fallbackError };
        }
        if (!host.connectionMetadataExpected && (!host.assistantPanelExpected || change.operation !== 'removed')) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined, {
          resource: 'integrations', operation: change.operation, id: change.id ?? integrationId, deviceId: host.remote?.deviceId,
          ...(change.operation === 'removed' ? {} : { after: { name: integrations.find(integration => integration.id === integrationId)?.name ?? integrationId } }),
        }, ownerId);
        return { success: true };
      } finally {
        setIntegrationMutating(integrationId, false);
        invalidateStatuses();
      }
    },
    [integrations, invalidateStatuses, setIntegrationMutating, host.remote?.deviceId,host.assistantPanelExpected,host.connectionMetadataExpected]
  );

  const connectIntegration = useCallback(
    async (integrationId: string, input: IntegrationFormInput, editAccountId?: string) =>
      runConnectionMutation(
        integrationId,
        () => api.connect(integrationId, input, editAccountId),
        'Failed to connect.'
      ),
    [runConnectionMutation, api]
  );

  const disconnectIntegration = useCallback(
    async (integrationId: string, accountId?: string) =>
      runConnectionMutation(
        integrationId,
        () => api.disconnect(integrationId, accountId),
        'Failed to disconnect.',
        { operation: 'removed', id: accountId ? `${integrationId}:${accountId}` : integrationId },
      ),
    [runConnectionMutation, api]
  );

  const authorizeIntegration = useCallback(
    async (integrationId: string) =>
      runConnectionMutation(
        integrationId,
        () => api.authorize(integrationId),
        'Failed to authorize.'
      ),
    [runConnectionMutation, api]
  );

  // 每次起命令行连接领一个号;取消就作废,还在等工具装好的那一圈不再起登录。
  const cliGenerations = useRef(new Map<string, number>());
  const cancelIntegrationAuthorization = useCallback(
    (integrationId: string) => {
      cliGenerations.current.set(integrationId, (cliGenerations.current.get(integrationId) ?? 0) + 1);
      void api.cancelAuthorization(integrationId);
    },
    [api]
  );

  const startCliLogin = useCallback(
    async (integrationId: string) => {
      const ownerId = cachedDevicesAccount();
      setIntegrationMutating(integrationId, true);
      try {
        const generation = (cliGenerations.current.get(integrationId) ?? 0) + 1;
        cliGenerations.current.set(integrationId, generation);
        const result = await prepareThenStartCliLogin(api, integrationId, {
          cancelled: () => cliGenerations.current.get(integrationId) !== generation,
          timeoutError: () => new Error(translateSessionMessage('integrations.cliPrepareTimedOut')),
        });
        if (!result) return { success: false as const, error: 'This connection attempt was cancelled.', cancelled: true as const };
        if (result.success && 'connected' in result) {
          invalidateStatuses();
          if (!host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
            { resource: 'integrations', operation: 'saved', id: integrationId, deviceId: host.remote?.deviceId }, ownerId);
        }
        return result;
      } finally {
        setIntegrationMutating(integrationId, false);
      }
    },
    [api, invalidateStatuses, setIntegrationMutating, host.remote?.deviceId,host.connectionMetadataExpected]
  );

  const waitCliLogin = useCallback(
    async (integrationId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await api.cliLoginWait(integrationId);
      if (result.status !== 'pending') invalidateStatuses();
      if (result.status === 'connected' && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', id: integrationId, deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    [api, invalidateStatuses, host.remote?.deviceId,host.connectionMetadataExpected]
  );

  const readCliProgress = useCallback((integrationId: string) => api.cliLoginProgress(integrationId), [api]);

  const isIntegrationMutating = useCallback(
    (integrationId: string) => mutatingIntegrationIds.has(integrationId),
    [mutatingIntegrationIds]
  );

  const connectionStatus = useMemo(
    () => ({ ...defaultConnectionStatuses(integrations), ...(statusData ?? {}) }),
    [integrations, statusData]
  );
  const integrationById = useMemo(
    () =>
      Object.fromEntries(
        integrations.map((integration: IntegrationMetadata) => [integration.id, integration])
      ),
    [integrations]
  );

  return (
    <IntegrationsContext.Provider
      value={{
        integrations,
        connectionOperations: ownerSnapshot?.application ?? [],
        integrationById,
        connectionStatus,
        checkedConnections: statusData ?? {},
        connectionCheckError: metadataExpected && statusData !== undefined && isAssistantPanelReadRetryable(connectionReadError) ? null : connectionReadError,
        hasConfiguredConnections: configuredData !== undefined,
        configuredConnectionsError: metadataExpected && configuredData !== undefined && isAssistantPanelReadRetryable(configuredConnectionsError) ? null : configuredConnectionsError,
        configuredConnections,
        isCheckingConfiguredConnections,
        isCheckingConnections: isCheckingConnections,
        reloadConnections: invalidateStatuses,
        connectIntegration,
        disconnectIntegration,
        authorizeIntegration,
        cancelIntegrationAuthorization,
        startCliLogin,
        waitCliLogin,
        readCliProgress,
        isIntegrationMutating,
        listError,
        hasList: listData !== undefined,
        reloadList: () => void refetchList(),
      }}
    >
      {children}
    </IntegrationsContext.Provider>
  );
}

export function useIntegrationsContext() {
  const ctx = useContext(IntegrationsContext);
  if (!ctx) throw new Error('useIntegrationsContext must be used inside IntegrationsProvider');
  return ctx;
}
