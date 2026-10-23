import { useMemo } from 'react'
import { assistantRoutines } from '@/session/renderer/features/assistant/assistant-schedule'
import type { Automation } from '@/session/shared/core/automations/automation'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import type { PhonePageProps } from './MobileAssistantApp'
import { useCloudDevice } from './phoneMachine'
import { usePhoneRead } from './usePhoneRead'

/**
 * 它排的定时任务:它家里那台的「已安排」(问那台机器,与桌面同一个控制器),醒着才读(❌ 自己叫醒)。
 * 列表与详情共用这一份;哪些是它排的 = assistantRoutines(与桌面同一条判定)。
 */
export function usePhoneRoutines({ assistant, home, homeDeviceId, readiness }: Pick<PhonePageProps, 'assistant' | 'home' | 'homeDeviceId' | 'readiness'>) {
  const device = useCloudDevice(homeDeviceId)
  const live = useLiveDeviceSessions()
  const listed = device ? deviceSessionsOf(device, live) : undefined
  const read = usePhoneRead<Automation[]>(
    readiness === 'ready' && homeDeviceId ? `routines|${homeDeviceId}` : null,
    () => machineRpc(homeDeviceId!).automations.listAutomations(),
    'list routines',
  )
  const automations = read.state === 'ok' ? read.data : null
  const routines = useMemo(() => {
    const sessions = device ? deviceSessionsOf(device, live).sessions : []
    return assistantRoutines(automations ?? [], new Map(sessions.map((s) => [s.conversationId, s.agent?.userId ?? null])), assistant.id, home?.kind === 'cloud')
  }, [automations, device, live, assistant.id, home?.kind])
  // A shared computer can host other agents; its directory is part of the ownership read.
  return { read, routines, directory: home?.kind === 'computer' ? listed : null }
}
