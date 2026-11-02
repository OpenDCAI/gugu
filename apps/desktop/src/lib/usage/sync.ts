// Each device uploads its own usage. Headless hosts use this same sync policy.
import { createUsageSync, type UsageSyncResult } from '@gugu/core/shared/usage/sync'
import { platform } from '../../platform'
import { getCurrentAuthUserId } from '../supabase'
import { replaceDeviceRows } from './cloud'

export function canSyncLocalUsage(): boolean {
  return typeof platform.getLocalUsageSnapshot === 'function'
}
export type SyncResult = UsageSyncResult
const sync = createUsageSync({
  identity: async () => {
    const userId = await getCurrentAuthUserId()
    const device = await platform.getLocalDeviceSelfSnapshot?.()
    return device?.device_id ? { userId, deviceId: device.device_id } : null
  },
  readState: key => {
    try { return JSON.parse(localStorage.getItem(key) ?? '{}') } catch { return {} }
  },
  writeState: (key, state) => localStorage.setItem(key, JSON.stringify(state)),
  snapshot: request => platform.getLocalUsageSnapshot!(request),
  replaceRows: replaceDeviceRows,
})
export function syncLocalUsage(options: { force?: boolean } = {}): Promise<SyncResult> {
  return canSyncLocalUsage() ? sync(options) : Promise.resolve('unsupported')
}
