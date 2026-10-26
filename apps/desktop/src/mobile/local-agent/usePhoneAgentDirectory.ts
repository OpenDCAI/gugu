import { useEffect, useRef } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import type { SessionpageProjectSummary, SessionpageSessionSummary, SessionpageSessionsListResult } from '@gugu/session-core/session-record/contract'
import { fetchPhoneSessions } from '../agent-watch/sessionpage-rpc'
import { liveDeviceSessions, registerDeviceSessionsRetry, updateDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { readCachedSessionList, writeCachedSessionList } from '@/session/shared/remote-sessions/session-list-cache'
import { reconnectDelayMs } from '@/session/shared/remote-reconnect'
import { getCurrentAuthUserId } from '@/lib/supabase'
import { useAuth } from '@/store/auth'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'
import { nativeAgent, phoneAgentAvailable } from './nativeAgent'

const REFRESH_MS = 5_000

/** Migrate the existing native journal even when an older App never saved directory summaries. */
export async function readLocalPhoneSessions(deviceId: string): Promise<SessionpageSessionsListResult | null> {
  if (!phoneAgentAvailable()) return null
  const ownerId = await getCurrentAuthUserId()
  if (thisPhoneDeviceId(ownerId) !== deviceId) return null
  const host = await nativeAgent.hostState({ ownerId })
  if (!host.sessions.length) return null
  if (host.ownerId !== ownerId || host.deviceId !== deviceId) throw new Error('手机会话与当前账号或设备不一致')
  const previous = liveDeviceSessions()[deviceId]
  const sessions = host.sessions.map((agent): SessionpageSessionSummary => {
    const existing = previous?.sessions.find((entry) => entry.conversationId === agent.sessionId)
    return { ...existing, conversationId: agent.sessionId, projectId: host.project?.id ?? existing?.projectId ?? '', title: agent.displayName,
      harness: 'pi', runtime: 'acp', agentStatus: agent.status, status: { status: agent.status, detail: agent.status === 'working' ? 'running' : agent.status === 'needs_user' ? 'question' : null },
      lastInteractedAt: agent.lastActiveAt ?? null, supported: host.taskTimeline === true,
      recordState: host.taskTimeline === true ? undefined : 'harness-unsupported', agent: { userId: agent.agentUserId }, chatId: agent.chatId }
  })
  return { projects: host.project ? [host.project] : [...(previous?.projects ?? [])], sessions }
}

/** 手机目录沿用摘要接口；任务记录通过手机专用的游标接口读取。 */
export function startPhoneAgentDirectorySync(deviceId: string, reachable: boolean, fetch = fetchPhoneSessions, readLocal?: typeof readLocalPhoneSessions): (() => void) & { refresh: () => Promise<void> } {
  let stopped = false
  let received = false
  let requesting: Promise<void> | null = null
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const previous = liveDeviceSessions()[deviceId]
  updateDeviceSessions(deviceId, { cached: true, connected: false, loading: reachable && !previous?.sessions.length, error: null })

  void readCachedSessionList<SessionpageProjectSummary, SessionpageSessionSummary>(deviceId).then((stored) => {
    if (stopped || received || !stored || liveDeviceSessions()[deviceId]?.sessions.length) return
    const current = liveDeviceSessions()[deviceId]
    updateDeviceSessions(deviceId, { ...stored, cached: true, loading: current?.loading ?? false, error: current?.error ?? null })
  }).then(async () => {
    if (stopped || received || !readLocal) return
    const stored = await readLocal(deviceId)
    if (stopped || received || !stored) return
    received = true
    const current = liveDeviceSessions()[deviceId]
    updateDeviceSessions(deviceId, { ...stored, cached: true, loading: current?.loading ?? false, error: current?.error ?? null })
    writeCachedSessionList(deviceId, stored)
  }).catch((cause: unknown) => {
    if (!stopped && !received) updateDeviceSessions(deviceId, { cached: true, error: cause instanceof Error ? cause.message : String(cause) })
  })

  const refresh = (): Promise<void> => {
    if (stopped || !reachable) return Promise.resolve()
    if (requesting) return requesting
    if (timer) clearTimeout(timer)
    const pending = (async () => {
      try {
        const result: SessionpageSessionsListResult = await fetch(deviceId)
        if (stopped) return
        received = true
        failures = 0
        updateDeviceSessions(deviceId, { ...result, cached: false, connected: true, loading: false, error: null })
        writeCachedSessionList(deviceId, result)
      } catch (cause) {
        if (stopped) return
        failures += 1
        updateDeviceSessions(deviceId, { cached: true, connected: false, loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (!stopped && reachable) timer = setTimeout(() => { void refresh() }, failures ? reconnectDelayMs(failures + 1) : REFRESH_MS)
      }
    })()
    requesting = pending
    void pending.then(() => { if (requesting === pending) requesting = null })
    return pending
  }
  const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
  if (reachable) {
    void refresh()
    document.addEventListener('visibilitychange', onVisible)
  }
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (reachable) document.removeEventListener('visibilitychange', onVisible)
    updateDeviceSessions(deviceId, { cached: true, connected: false, loading: false })
  }
  return Object.assign(stop, { refresh })
}

/** 移动壳根的唯一手机目录同步点。关闭宿主后的设备仍读本地摘要,不向动作设备发送宿主 RPC。 */
export function usePhoneAgentDirectory(devices: readonly Device[]): void {
  const ownerId = useAuth().user?.id ?? null
  const phones = devices.filter(isPhoneDevice)
  const active = phones.filter((device) => device.is_online && isAgentHostDevice(device)).map((device) => device.device_id)
  const retryScope = useRef({ ownerId, active })
  retryScope.current = { ownerId, active }
  const key = phones.map((device) => `${device.device_id}:${device.is_online && isAgentHostDevice(device) ? 'online' : 'offline'}`).sort().join(',')
  useEffect(() => {
    const stops = phones.flatMap((device) => {
      const sync = startPhoneAgentDirectorySync(device.device_id, device.is_online && isAgentHostDevice(device), fetchPhoneSessions, readLocalPhoneSessions)
      if (!ownerId || !device.is_online || !isAgentHostDevice(device)) return [sync]
      const unregister = registerDeviceSessionsRetry(ownerId, device.device_id, async () => {
        if (retryScope.current.ownerId !== ownerId || !retryScope.current.active.includes(device.device_id)) throw new Error('账号或手机宿主状态已改变，请重新打开项目列表。')
        await sync.refresh()
        if (retryScope.current.ownerId !== ownerId || !retryScope.current.active.includes(device.device_id)) return
        const error = liveDeviceSessions()[device.device_id]?.error
        if (error) throw new Error(error)
      })
      return [sync, unregister]
    })
    return () => { for (const stop of stops) stop() }
    // 设备心跳只改变排序/时间,不应重启整张目录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ownerId])
}
