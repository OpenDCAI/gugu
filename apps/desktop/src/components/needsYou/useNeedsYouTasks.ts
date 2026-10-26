import { useEffect, useState } from 'react'
import type { SessionpageSessionsListResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { platform } from '@/platform'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { startSessionListSync } from '@/session/shared/remote-sessions/session-list-sync'
import { machineSessionListClient } from '@/session/renderer/features/remote-hosts/machine-session-list'
import { sessionReading } from '@/mobile/agent-watch/watch-status'

export type NeedsYouTask = {
  deviceId: string
  machine: string
  local: boolean
  session: SessionpageSessionSummary
}

/** The existing sidebar state and machine directory, including a desktop's own host. No per-task polling. */
export function useNeedsYouTasks(): { tasks: NeedsYouTask[]; error: string | null } {
  const { user } = useAuth()
  const { devices } = useDevicesStore()
  const directory = useLiveDeviceSessions()
  const current = devices.find(device => device.is_current_device)
  const localId = platform.capabilities.sessionHost ? current?.device_id : undefined
  const [local, setLocal] = useState<{ ownerId: string; deviceId: string; list: SessionpageSessionsListResult } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ownerId = user?.id
  useEffect(() => {
    if (!ownerId || !localId) return
    const sync = startSessionListSync(machineSessionListClient, 'local', {
      onList: list => setLocal({ ownerId, deviceId: localId, list }),
      onError: setError,
    })
    const foreground = platform.subscribeAppForeground(() => sync.reconnect(), () => undefined)
    return () => { foreground(); sync.stop() }
  }, [ownerId, localId])

  const tasks: NeedsYouTask[] = []
  if (!ownerId) return { tasks, error: null }
  for (const device of devices) {
    const here = device.device_id === localId
    const live = directory[device.device_id]
    const sessions = here
      ? local?.ownerId === ownerId && local.deviceId === localId ? local.list.sessions : []
      : device.is_online && live && !live.cached && !live.error ? live.sessions : []
    for (const session of sessions) {
      if (sessionReading(session)?.status !== 'needs_user') continue
      tasks.push({ deviceId: device.device_id, machine: device.label, local: here, session })
    }
  }
  return { tasks, error: localId ? error : null }
}
