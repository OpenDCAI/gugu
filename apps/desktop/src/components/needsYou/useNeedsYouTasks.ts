import { useEffect, useState } from 'react'
import type { SessionpageSessionsListResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { platform } from '@/platform'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { startSessionListSync } from '@/session/shared/remote-sessions/session-list-sync'
import { machineSessionListClient } from '@/session/renderer/features/remote-hosts/machine-session-list'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { usePhoneAgentDirectory } from '@/mobile/local-agent/usePhoneAgentDirectory'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { mostUrgentAttention, type AgentAttention } from '@gugu/core/shared/agentStatus'
import { isNeedsYou, presentationAttention } from '@gugu/core/shared/agentStatusPresentation'

export type NeedsYouTask = {
  deviceId: string
  machine: string
  local: boolean
  phoneHost: boolean
  session: SessionpageSessionSummary
}

/** The existing sidebar state and machine directory, including a desktop's own host. No per-task polling. */
export function useNeedsYouTasks(): { tasks: NeedsYouTask[]; attention: AgentAttention; error: string | null } {
  const { user } = useAuth()
  const { devices, phones = [] } = useDevicesStore()
  usePhoneAgentDirectory([...devices, ...phones])
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
  const statuses: AgentAttention[] = []
  if (!ownerId) return { tasks, attention: null, error: null }
  for (const device of devices) {
    const here = device.device_id === localId
    const live = directory[device.device_id]
    const sessions = here
      ? local?.ownerId === ownerId && local.deviceId === localId ? local.list.sessions : []
      : device.is_online && live && !live.cached && !live.error ? live.sessions : []
    for (const session of sessions) {
      // 列出的只有连得上的宿主;有身份的 agent 读共享 presence,与侧栏同一个判据。
      const presentation = sessionPresentation(session, true)
      statuses.push(presentationAttention(presentation))
      if (!isNeedsYou(presentation)) continue
      tasks.push({ deviceId: device.device_id, machine: device.label, local: here, phoneHost: isPhoneDevice(device), session })
    }
  }
  return { tasks, attention: mostUrgentAttention(statuses), error: localId ? error : null }
}
