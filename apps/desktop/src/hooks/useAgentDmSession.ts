import { useCallback, useState } from 'react'
import { useAuth } from '../store/auth'
import { useContactsStore } from '../store/contactsContext'
import { useDevicesStore } from '../store/devicesContext'
import { retryDeviceSessions, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { useAgentSessionRow } from '@/mobile/agent-watch/useAgentSessionRow'
import { rendererLogger } from '../lib/log'
import { useSessionpageAgentProjection } from './useSessionpageAgentProjection'

const log = rendererLogger('chat/agent-dm-session')

/**
 * 和 agent 的私聊画的是它那条会话的记录(任务页同一个 ChatTranscript):这个 agent 在哪台机器的哪条会话。
 * 解析不到也说清楚是哪一种 —— 已有 DM 仍由共享转录展示；这个结果只决定是否还能读取会话过程。
 */
export type AgentDmSession =
  | { state: 'resolving' }
  | { state: 'ready'; deviceId: string; sessionId: string; local: boolean }
  | { state: 'no-session' }
  | { state: 'machine-offline'; deviceId: string }
  | { state: 'failed'; message: string }

/**
 * 本机的 agent 问本机宿主(会话页的 agent 映射,`useSessionpageAgentProjection`);别的机器上的从会话目录里找
 * (`useAgentSessionRow`,与手机「在任务中打开」同一份)。桌面项目页与手机私聊都用它。
 */
export function useAgentDmSession(agentUserId: string | null): { session: AgentDmSession; retry: () => void } {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const { devices } = useDevicesStore()
  const [attempt, setAttempt] = useState(0)
  const deviceId = contacts.find((contact) => contact.id === agentUserId)?.device_id ?? null
  const device = devices.find((candidate) => candidate.device_id === deviceId) ?? null
  const local = device?.is_current_device === true
  const projection = useSessionpageAgentProjection(agentUserId && local ? agentUserId : null, attempt)
  const row = useAgentSessionRow(agentUserId && device && !local ? agentUserId : null)
  const live = useLiveDeviceSessions()

  const retry = useCallback(() => {
    setAttempt((value) => value + 1)
    if (!local && deviceId && user?.id) {
      void retryDeviceSessions(user.id, deviceId).catch((error: unknown) => log.warn({ deviceId, error: String(error) }, 'agent dm: device sessions retry failed'))
    }
  }, [local, deviceId, user?.id])

  return {
    session: resolveAgentDmSession({
      agentUserId, deviceId, devicesLoaded: devices.length > 0,
      device: device ? { local, online: device.is_online === true } : null,
      projection, row: row ? { deviceId: row.deviceId, sessionId: row.session.conversationId } : null,
      directory: deviceId ? live[deviceId] ?? null : null,
    }),
    retry,
  }
}

/** 上面那个 hook 的判定本体(纯函数,带用例)。 */
export function resolveAgentDmSession(input: {
  agentUserId: string | null
  deviceId: string | null
  devicesLoaded: boolean
  device: { local: boolean; online: boolean } | null
  projection: { kind: string; context: { sessionId: string } | null; error: string | null }
  row: { deviceId: string; sessionId: string } | null
  directory: { loading: boolean; error: string | null } | null
}): AgentDmSession {
  const { agentUserId, deviceId, device, projection, row, directory } = input
  if (!agentUserId) return { state: 'no-session' }
  // 设备列表还没读到这台(开机头几秒、联系人里还没有它的设备):还在找,❌ 说「没有会话」。
  if (!deviceId || !device) return input.devicesLoaded ? { state: 'no-session' } : { state: 'resolving' }
  if (device.local) {
    if (projection.kind === 'mapped' && projection.context) return { state: 'ready', deviceId, sessionId: projection.context.sessionId, local: true }
    if (projection.kind === 'unmapped') return { state: 'no-session' }
    if (projection.kind === 'error') return { state: 'failed', message: projection.error ?? 'unknown' }
    return { state: 'resolving' }
  }
  if (row) return { state: 'ready', deviceId: row.deviceId, sessionId: row.sessionId, local: false }
  if (!device.online) return { state: 'machine-offline', deviceId }
  // 那台机器的会话目录还在读:还在找。读完了还没有它,才是「没有会话」。
  if (!directory || directory.loading) return { state: 'resolving' }
  if (directory.error) return { state: 'failed', message: directory.error }
  return { state: 'no-session' }
}
