import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type { AgentSettings } from '@shared/core/agents/agent-payload';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

/** 最后一段是哪台机器(#6264):附加参数与环境变量是那台机器上这家的设置,❌ 与本机共用一格缓存。 */
function agentSettingsQueryKey(id: string, hostKey: string) {
  return ['agents', 'settings', id, hostKey] as const;
}

/**
 * Manages settings for a single agent: current value, defaults, mutations for
 * update and reset-to-defaults.
 *
 * Replaces `use-provider-settings.ts`.
 */
export function useAgentSettings(id: string) {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const agentsRpc = host.agents;
  const queryKey = agentSettingsQueryKey(id, host.key);

  const query = useQuery<AgentSettings | null>({
    queryKey,
    queryFn: () => agentsRpc.getSettings(id),
    enabled: host.remote?.online !== false,
    staleTime: 60_000,
  });

  const updateMutation = useMutation<void, Error, Partial<ProviderCustomConfig>>({
    mutationFn: (config) => agentsRpc.updateSettings(id, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const resetMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      const defaults = await agentsRpc.getDefaultSettings(id);
      if (defaults) {
        await agentsRpc.updateSettings(id, defaults);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const { data } = query;
  return {
    ...query,
    value: data?.value,
    defaults: data?.defaults,
    overrides: data?.overrides,
    isSaving: updateMutation.isPending || resetMutation.isPending,
    isOverridden: !!(data?.overrides && Object.keys(data.overrides).length > 0),
    isFieldOverridden: (field: keyof ProviderCustomConfig) =>
      !!(data?.overrides && field in data.overrides),
    update: updateMutation.mutate,
    updateAsync: updateMutation.mutateAsync,
    reset: resetMutation.mutate,
  };
}
