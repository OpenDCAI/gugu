import { useEffect, useSyncExternalStore } from 'react'
import { queryClient } from '@renderer/lib/query-client'
import { getAppSettingValueSnapshot, prefetchAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'

/** The existing application settings own persistence; an unread setting remains off. */
export function globalSearchV3Enabled() {
  return getAppSettingValueSnapshot('globalSearch')?.v3 === true
}

const subscribe = (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange)

/** Reads the same settings cache without a query provider, so the chat store can use it on every surface. */
export function useGlobalSearchV3() {
  useEffect(() => { void prefetchAppSettingsKey('globalSearch') }, [])
  return useSyncExternalStore(subscribe, globalSearchV3Enabled)
}
