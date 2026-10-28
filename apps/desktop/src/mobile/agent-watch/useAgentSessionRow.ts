import { useMemo } from 'react'
import { useDevicesStore } from '@/store/devicesContext'
import { directoryRows, useLiveDeviceSessions, type SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

/**
 * 这个 agent 是哪台机器上的哪条会话(#7197):从手机现有的会话目录里找(行上带 agent 的 id),❌ 另问一遍。
 * 一个 agent 有好几行(换过机器、旧会话还在目录里)时取最近交互的那一行(同 #658「an agent row opens its latest
 * session」),❌ 目录里排第一的那行:云浏览器卡读的是这条会话里待办的求助,读旧会话就看不到它此刻的求助。
 * null = 找不到(不是某台机器上的会话、或账号下没有它)—— 私聊页头就不放模式按钮,与桌面「解析不到就不渲染」同一条;
 * agentUserId 为 null = 不找。
 */
export function useAgentSessionRow(agentUserId: string | null): SessionDirectoryRow | null {
  const { devices } = useDevicesStore()
  const live = useLiveDeviceSessions()
  return useMemo(() => (agentUserId ? latestAgentSessionRow(directoryRows(devices, live), agentUserId) : null), [agentUserId, devices, live])
}

/** The agent's most recently used session among the directory rows (`lastInteractedAt`), or null. */
export function latestAgentSessionRow(rows: readonly SessionDirectoryRow[], agentUserId: string): SessionDirectoryRow | null {
  let latest: SessionDirectoryRow | null = null
  for (const row of rows) {
    if (row.session.agent?.userId !== agentUserId) continue
    if (!latest || (row.session.lastInteractedAt ?? '') > (latest.session.lastInteractedAt ?? '')) latest = row
  }
  return latest
}
