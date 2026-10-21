import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import {
  APP_SETTINGS_STALE_TIME_MS,
  appSettingsMetaQueryKey,
  getAllAppSettingsFromCache,
  getAppSettingValueSnapshot,
  invalidateAppSettingsKey,
  mergeAppSettingsValue,
  prefetchAppSettingsKey,
  requestAppSettingsMeta,
  resetAppSettingsFieldRequest,
  resetAppSettingsRequest,
  restoreAppSettingsCache,
  setAppSettingsValueInCache,
  updateAppSettingsRequest,
  type SettingsMeta,
} from './app-settings-client';
import { useSettingsHost } from './settings-host';

export { getAppSettingValueSnapshot, prefetchAppSettingsKey };

export function useAppSettingsKey<K extends AppSettingsKey>(key: K) {
  const queryClient = useQueryClient();
  // #6264 跟机器走的那几组(默认 tmux、仓库)在「选了别的机器」时读写那台机器;缓存另起一份键,
  // ❌ 动本机的全局设置缓存(那一份整个窗口都在读)。
  const host = useSettingsHost();
  const remote = host.remote;
  const metaKey = remote ? [...appSettingsMetaQueryKey(key), host.key] : appSettingsMetaQueryKey(key);

  const { data, isLoading, error } = useQuery<SettingsMeta<K>>({
    queryKey: metaKey,
    queryFn: () =>
      remote ? (host.api.getWithMeta(key) as Promise<SettingsMeta<K>>) : requestAppSettingsMeta(key),
    staleTime: APP_SETTINGS_STALE_TIME_MS,
    // 那台机器离线就不问(问不到,只会挂满超时)。
    enabled: remote ? remote.online : true,
    ...(remote ? { retry: false } : {}),
  });

  const invalidate = () => {
    if (remote) void queryClient.invalidateQueries({ queryKey: metaKey });
    else invalidateAppSettingsKey(key);
  };

  const updateMutation = useMutation<
    void,
    Error,
    Partial<AppSettings[K]>,
    { prev: SettingsMeta<K> | undefined; prevAll: AppSettings | undefined }
  >({
    mutationFn: (partial) => {
      const current = queryClient.getQueryData<SettingsMeta<K>>(metaKey);
      const merged = mergeAppSettingsValue(current?.value, partial);
      return remote ? host.api.update(key, merged) : updateAppSettingsRequest(key, merged);
    },
    onMutate: async (partial) => {
      await queryClient.cancelQueries({ queryKey: metaKey });
      const prev = queryClient.getQueryData<SettingsMeta<K>>(metaKey);
      const merged = mergeAppSettingsValue(prev?.value, partial);
      if (remote) {
        if (prev) queryClient.setQueryData<SettingsMeta<K>>(metaKey, { ...prev, value: merged });
        return { prev, prevAll: undefined };
      }
      const prevAll = getAllAppSettingsFromCache();
      setAppSettingsValueInCache(key, merged);
      return { prev, prevAll };
    },
    onError: (_err, _partial, ctx) => {
      if (remote) {
        if (ctx?.prev) queryClient.setQueryData(metaKey, ctx.prev);
      } else if (ctx) restoreAppSettingsCache(key, ctx.prev, ctx.prevAll);
      invalidate();
    },
    onSettled: () => {
      invalidate();
    },
  });

  const resetMutation = useMutation<void, Error, void>({
    mutationFn: () => (remote ? host.api.reset(key) : resetAppSettingsRequest(key)),
    onSuccess: () => {
      invalidate();
    },
  });

  const resetFieldMutation = useMutation<void, Error, keyof AppSettings[K]>({
    mutationFn: (field) =>
      remote ? host.api.resetField(key, String(field)) : resetAppSettingsFieldRequest(key, field),
    onSuccess: () => {
      invalidate();
    },
  });

  // 别的机器此刻做不了事:离线,或读都没读到(server 太旧 / 问不通)—— 行照旧画,开关一起灰。
  const unavailable = !!remote && (!remote.online || (!!error && !data));

  return {
    value: data?.value,
    defaults: data?.defaults,
    overrides: data?.overrides,
    // 在读 / 读不到都当作「还不能动」,开关灰着(与本机读的时候同一个样子)。
    isLoading: isLoading || unavailable,
    error,
    isSaving: updateMutation.isPending || resetMutation.isPending || resetFieldMutation.isPending,
    isOverridden: !!(data?.overrides && Object.keys(data.overrides).length > 0),
    isFieldOverridden: (field: keyof AppSettings[K]) =>
      !!(data?.overrides && field in data.overrides),
    update: updateMutation.mutate,
    updateAsync: updateMutation.mutateAsync,
    reset: resetMutation.mutate,
    resetField: (field: keyof AppSettings[K]) => resetFieldMutation.mutate(field),
  };
}
