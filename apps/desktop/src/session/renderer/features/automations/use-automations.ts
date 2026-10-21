import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onMachineEvent } from '@renderer/lib/ipc';
import type {
  CreateAutomationParams,
  UpdateAutomationSettingsPatch,
} from '@shared/core/automations/automation';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import { automationsQueryKey, useAutomationsHost, type AutomationsHost } from './automations-host';

/**
 * 别的机器:离线就不问(问不到,只会挂满超时)。变化与本机一样靠那台机器推来的事件(#6264 会话页宿主连接),❌ 轮询。
 */
function remoteQueryOptions(host: AutomationsHost) {
  if (!host.remote) return {};
  // 变化由那台机器推事件来(与本机同一套);切回窗口 ❌ 再问一遍(每一问都是一次跨网往返)。
  return { enabled: host.remote.online, retry: false, refetchOnWindowFocus: false } as const;
}

/** 这一页看的那台机器(null = 本机)。 */
function machineOf(host: AutomationsHost): string | null {
  return host.remote?.deviceId ?? null;
}

export function useAutomations(projectId?: string) {
  const queryClient = useQueryClient();
  const host = useAutomationsHost();
  const api = host.api;

  function invalidateAutomations() {
    void queryClient.invalidateQueries({ queryKey: automationsQueryKey(host, projectId) });
  }

  function invalidateRuns(automationId?: string) {
    void queryClient.invalidateQueries({
      queryKey: automationId
        ? automationsQueryKey(host, 'runs', automationId)
        : automationsQueryKey(host, 'runs'),
    });
  }

  const automations = useQuery({
    queryKey: automationsQueryKey(host, projectId),
    queryFn: () => api.listAutomations(projectId),
    placeholderData: keepPreviousData,
    ...remoteQueryOptions(host),
  });

  const create = useMutation({
    mutationFn: (params: CreateAutomationParams) => api.createAutomation(params),
    onSuccess: invalidateAutomations,
  });

  const updateSettings = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAutomationSettingsPatch }) =>
      api.updateAutomationSettings(id, patch),
    onSuccess: invalidateAutomations,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameAutomation(id, name),
    onSuccess: invalidateAutomations,
  });

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setAutomationEnabled(id, enabled),
    onSuccess: invalidateAutomations,
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleAutomationEnabled(id, enabled),
    onSuccess: invalidateAutomations,
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.runAutomation(id),
    onSuccess: (_run, id) => invalidateRuns(id),
  });

  const stop = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSuccess: () => invalidateRuns(),
  });

  const destroy = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: invalidateAutomations,
  });

  return {
    automations,
    create,
    updateSettings,
    rename,
    setEnabled,
    toggleEnabled,
    runNow,
    stop,
    destroy,
  };
}

export function useAutomationRuns(automationId: string, limit = 20) {
  const host = useAutomationsHost();
  return useQuery({
    queryKey: automationsQueryKey(host, 'runs', automationId, limit),
    queryFn: () => host.api.listAutomationRuns(automationId, limit, 0),
    ...remoteQueryOptions(host),
    enabled: !!automationId && host.remote?.online !== false,
  });
}

const PAGINATED_PAGE_SIZE = 25;

export function useScheduledAutomationRun(automationId: string) {
  const host = useAutomationsHost();
  return useQuery({
    queryKey: automationsQueryKey(host, 'runs', automationId, 'scheduled'),
    queryFn: () => host.api.getNextScheduledRun(automationId),
    ...remoteQueryOptions(host),
    enabled: !!automationId && host.remote?.online !== false,
  });
}

type RunStatusFilter = 'done' | 'failed' | 'skipped' | undefined;

export function useAutomationRunsPaginated(
  automationId: string,
  page: number,
  statusFilter?: RunStatusFilter
) {
  const host = useAutomationsHost();
  return useQuery({
    queryKey: automationsQueryKey(host, 'runs', automationId, 'page', page, statusFilter),
    queryFn: () =>
      host.api.listAutomationRuns(
        automationId,
        PAGINATED_PAGE_SIZE + 1,
        page * PAGINATED_PAGE_SIZE,
        statusFilter
      ),
    placeholderData: keepPreviousData,
    ...remoteQueryOptions(host),
    enabled: !!automationId && host.remote?.online !== false,
  });
}

export function useAutomationRunCounts(automationId: string) {
  const host = useAutomationsHost();
  return useQuery({
    queryKey: automationsQueryKey(host, 'runs', automationId, 'counts'),
    queryFn: () => host.api.countAutomationRunsByStatus(automationId),
    ...remoteQueryOptions(host),
    enabled: !!automationId && host.remote?.online !== false,
  });
}

export function useLatestAutomationRun(automationId: string) {
  const queryClient = useQueryClient();
  const host = useAutomationsHost();
  const key = automationsQueryKey(host, 'runs', automationId, 'latest');

  useEffect(() => {
    // 只听这一页看的那台机器推的(各台机器的事件在渲染层合流,见 lib/ipc.ts)。
    return onMachineEvent(machineOf(host), automationRunChangedChannel, ({ automationId: id, run }) => {
      if (id !== automationId) return;
      queryClient.setQueryData(key, run);
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId, queryClient, host.key]);

  return useQuery({
    queryKey: key,
    queryFn: () => host.api.getLatestRun(automationId),
    ...remoteQueryOptions(host),
    enabled: !!automationId && host.remote?.online !== false,
  });
}

export function useAutomationRun(automationId: string, runId: string) {
  const runs = useAutomationRuns(automationId);
  return runs.data?.find((r) => r.id === runId);
}

export function useAutomation(automationId: string, projectId?: string) {
  const { automations } = useAutomations(projectId);
  return automations.data?.find((a) => a.id === automationId);
}

export function useAutomationEventBridge(automationId: string) {
  const queryClient = useQueryClient();
  const host = useAutomationsHost();
  useEffect(() => {
    // 只听这一页看的那台机器推的(各台机器的事件在渲染层合流,见 lib/ipc.ts)。
    const machine = machineOf(host);
    const unsubChanged = onMachineEvent(machine, automationChangedChannel, ({ automationId: id }) => {
      if (id !== automationId) return;
      void queryClient.invalidateQueries({ queryKey: automationsQueryKey(host) });
      void queryClient.invalidateQueries({ queryKey: automationsQueryKey(host, 'runs', id, 'scheduled') });
    });
    const unsubRun = onMachineEvent(machine, automationRunChangedChannel, ({ automationId: id }) => {
      if (id !== automationId) return;
      void queryClient.invalidateQueries({ queryKey: automationsQueryKey(host, 'runs', id) });
    });
    return () => {
      unsubChanged();
      unsubRun();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId, queryClient, host.key]);
}
