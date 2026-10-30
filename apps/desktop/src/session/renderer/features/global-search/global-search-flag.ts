import { QueryObserver } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { queryClient } from '@renderer/lib/query-client'
import { APP_SETTINGS_STALE_TIME_MS, appSettingsMetaQueryKey, requestAppSettingsMeta, type SettingsMeta } from '@renderer/features/settings/app-settings-client'

// One observer of the existing settings query: while anything is subscribed (the chat store is, for the whole
// signed-in session) the cache entry cannot be collected, and it needs no query provider. An unread setting stays
// off, which is also what a shell without the desktop search host (the phone) reads. The renderer uses it to decide
// what to show and whether to feed at all; the main process still decides whether search.write writes.
const observer = new QueryObserver<SettingsMeta<'globalSearch'>>(queryClient, {
  queryKey: appSettingsMetaQueryKey('globalSearch'),
  queryFn: () => requestAppSettingsMeta('globalSearch'),
  staleTime: APP_SETTINGS_STALE_TIME_MS,
})

export const globalSearchV3Enabled = () => observer.getCurrentResult().data?.value.v3 === true

export function useGlobalSearchV3(): boolean {
  return useSyncExternalStore((onChange) => observer.subscribe(onChange), globalSearchV3Enabled, () => false)
}
