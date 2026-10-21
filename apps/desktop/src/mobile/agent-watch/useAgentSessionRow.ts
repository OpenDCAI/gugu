import { useMemo } from 'react'
import { useDevicesStore } from '@/store/devicesContext'
import { directoryRows, useLiveDeviceSessions, type SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

/**
 * 这个 agent 是哪台机器上的哪条会话(#7197):从手机现有的会话目录里找(行上带 agent 的 id),❌ 另问一遍。
 * null = 找不到(不是某台机器上的会话、或账号下没有它)—— 私聊页头就不放模式按钮,与桌面「解析不到就不渲染」同一条;
 * 页头据此决定要不要给它腾地方(ChatHeaderActions `modeButton`)。agentUserId 为 null = 不找。
 */
export function useAgentSessionRow(agentUserId: string | null): SessionDirectoryRow | null {
  const { devices } = useDevicesStore()
  const live = useLiveDeviceSessions()
  return useMemo(
    () => (agentUserId ? directoryRows(devices, live).find(({ session }) => session.agent?.userId === agentUserId) ?? null : null),
    [agentUserId, devices, live],
  )
}
