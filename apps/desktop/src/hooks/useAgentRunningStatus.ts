import { useMemo } from 'react'
import { useAgentDisplayStatus } from './useAgentDisplayStatus'
import type { ThreadScope } from '../store/threadScope'
import { useDevicesStore } from '../store/devicesContext'
import { resolveAgentLocation, resolveAgentRunningDisplayName } from '../lib/agentRunningStatusModels'
import { isTransientAgentConversationStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentLocation } from '@gugu/core/shared/ui/agentHeaderStatusModels'
import type { LocalAgentStatus } from '../lib/agentPresenceStore'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import type {
  AgentConversationActivity,
  AgentConversationActivityStatus,
  AgentDisplayStatus,
  AgentType,
} from '@gugu/core/shared/types/chat'

// 一个会话面要显示的 agent 运行态。它**没有自己的真值** —— 只是那张 agent 状态表
// (agentPresenceStore)的一次读,加上「这条会话里该拿谁的名字和头像画运行条」。
//
// 从前这里还调和第二个来源:一条按 (chat, thread) 分键的乐观 activity(发送即点亮、流式反推点亮、
// 重试点亮),再用 activeChatId 把权威的 running 按会话收口。两个来源 × 两道门,于是同一个 agent
// 在群里和单聊里能给出两个答案,而两边都「有道理」。现在只有一个来源、一种读法:
// 权威(宿主)说它在跑,它出现的每一面都显示运行中。

export interface AgentRunningStatus {
  /** 这个 agent 的展示态。会话列表 / 标题栏 / 头像 / 运行条 / composer 忙态读的是同一个值。 */
  status: AgentDisplayStatus
  /** 画成什么(那一句、颜色、动不动),与会话页、手机同一个 `presentAgentStatus`。头部文案读它。 */
  presentation: AgentStatusPresentation
  /** status ∈ {starting, running} —— 该不该显「运行中」UI 的唯一判据。 */
  isRunning: boolean
  /**
   * 运行条要画的那一条:isRunning 时非空、否则 null。身份来自本会话(peer),状态来自那张表 ——
   * ❌ 不再有「事件 activity 与合成条」两种形状,合成是唯一的形状。
   */
  runningActivity: AgentConversationActivity | null
  /** 这台机器就是它的宿主时,宿主按 agent 的流里那一条(审阅门、provider 阻塞只有它知道);否则 null。 */
  local: LocalAgentStatus | null
  // 头部「状态 · 位置 · 引擎」元数据(presence payload)
  agentType: AgentType | null
  /** active 载荷在但缺 agent_type(数据异常)→ 头部 fail-loud。removed tombstone 依 #2219 契约不带引擎,不算异常。 */
  engineMissing: boolean
  location: AgentLocation | null
  recentActions: string[]
  lastActionAt: string | null
  // 运行窗口打开(沿用 useAgentDisplayStatus)
  opening: boolean
  openRuntime: () => Promise<void>
}

// @@@2262 — 引擎缺失只对 active 载荷构成数据异常。removed tombstone 按 #2219 契约本就不携带 live 引擎字段
// (agent_type=null 是协议形状,不是缺数据);不按生命周期收口的话,agent 被删时仍开着的 DM 会把正常的
// removed 收敛误报成引擎异常(头部「已移除 · 引擎未知」+ console.error)。active 载荷真缺仍 fail loud。
export function isEngineMissing(
  payload: { accountStatus: 'active' | 'removed'; agentType: AgentType | null } | null,
): boolean {
  return Boolean(payload && payload.accountStatus === 'active' && !payload.agentType)
}

export function useAgentRunningStatus(input: {
  /** DM peer / 头部对象的 gugu user id;非 agent 聊天传 null。 */
  agentUserId: string | null
  chatId: string | null
  /** 运行条挂在哪个话题作用域下(合成条的 threadRootId)。 */
  scope: ThreadScope
  /** 合成 runningActivity 的展示身份。 */
  peerDisplayName: string
  peerAvatar: string | null
}): AgentRunningStatus {
  const { status, presence, opening, openRuntime } = useAgentDisplayStatus(input.agentUserId)
  const { devices } = useDevicesStore()

  const isRunning = isTransientAgentConversationStatus(status)
  const payload = presence?.payload ?? null
  const agentType = (payload?.agentType as AgentType | null | undefined) ?? null

  const runningActivity = useMemo<AgentConversationActivity | null>(() => {
    if (!isRunning || !input.agentUserId || !input.chatId) return null
    return {
      agentId: input.agentUserId,
      chatId: input.chatId,
      threadRootId: input.scope.rootId,
      displayName: resolveAgentRunningDisplayName(input.peerDisplayName, null),
      avatar: input.peerAvatar,
      startedAt: '',
      // 仅在 isRunning(status ∈ starting|running,均属 AgentConversationActivityStatus)时合成 → 安全收窄。
      status: status as AgentConversationActivityStatus,
    }
  }, [isRunning, status, input.agentUserId, input.chatId, input.scope.rootId, input.peerDisplayName, input.peerAvatar])

  return {
    status,
    presentation: presence.presentation,
    isRunning,
    runningActivity,
    local: presence?.local ?? null,
    agentType,
    engineMissing: isEngineMissing(payload),
    location: resolveAgentLocation(payload?.deviceId, devices),
    recentActions: payload?.recentActions ?? [],
    lastActionAt: payload?.lastActionAt ?? null,
    opening,
    openRuntime,
  }
}
