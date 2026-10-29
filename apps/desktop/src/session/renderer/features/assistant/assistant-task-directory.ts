import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { deviceSessionsOf, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { ListedSession } from './assistant-lineage'

/** Task visibility is independent of the full workspace capability used by machine pickers. */
export function assistantTaskDirectory(
  devices: readonly Device[],
  live: Readonly<Record<string, DeviceSessions>>,
  local?: { sessions: readonly SessionpageSessionSummary[]; loaded: boolean; error: string | null },
): ListedSession[] {
  return devices.flatMap((device) => {
    if (device.is_current_device && local?.loaded) {
      return local.sessions.map((summary) => ({ deviceId: device.device_id, summary, live: !local.error }))
    }
    const read = deviceSessionsOf(device, live)
    return read.sessions.map((summary) => ({ deviceId: device.device_id, summary, live: device.is_online && !read.cached && read.connected === true }))
  })
}
