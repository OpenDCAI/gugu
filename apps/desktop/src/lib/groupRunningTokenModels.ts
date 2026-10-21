import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { isTransientAgentConversationStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { RunningToken } from '../components/RunningTokenBar'
import { latestRecentAction } from '../components/agentRecentActionModel'
import type { AgentRecentActivity } from '../hooks/useAgentDisplayStatus'
import { kindToRunningState } from './agentRunningVerb'
import type { DisplayIdentity } from './displayIdentity'

// @@@1727 cap=3（非 8）：单行 token 条容器窄，4~8 并发 agent 时 cap=8 会撑破容器、第 5~8 个 token 被裁没
// 且不出「+N」（违反「排不下就 +N」不变量）。降到 3 → 超出的走 RunningTokenBar 已有的 +N 溢出（slice(0,cap)+MoreOverflow）。
export const GROUP_AGENT_BAR_MAX = 3

/**
 * 群的运行条 token。群聊页与从它长出来的话题页(手机)画的是同一份。
 * stateKey 由 presence recentActions 的最新 kind 派生;toolCount 近似用近 5 分钟 actions.length。
 */
export function groupRunningTokens(input: {
  agents: readonly { id: string }[]
  statuses: Readonly<Record<string, AgentDisplayStatus>>
  identities: Readonly<Record<string, Pick<DisplayIdentity, 'owner_user_id' | 'display_name' | 'avatar'> | undefined>>
  currentUserId: string | null | undefined
  recentActivity: Readonly<Record<string, AgentRecentActivity | undefined>>
}): RunningToken[] {
  return selectGroupRunningAgents(input).map((agent) => {
    const activity = input.recentActivity[agent.id]
    return {
      id: agent.id,
      name: input.identities[agent.id]?.display_name ?? '',
      avatarUrl: input.identities[agent.id]?.avatar ?? null,
      avatarSeed: agent.id,
      stateKey: kindToRunningState(latestRecentAction(activity?.actions ?? [], activity?.lastActiveAt ?? null)),
      toolCount: activity?.actions.length ?? 0,
      lastActiveAt: activity?.lastActiveAt ?? null,
    }
  })
}

/** Select before the bar applies its cap, so visible and overflow tokens share one order. */
export function selectGroupRunningAgents<T extends { id: string }>(input: {
  agents: readonly T[]
  statuses: Readonly<Record<string, AgentDisplayStatus>>
  identities: Readonly<Record<string, Pick<DisplayIdentity, 'owner_user_id'> | undefined>>
  currentUserId: string | null | undefined
}): T[] {
  const isOwn = (id: string) => Boolean(input.currentUserId && input.identities[id]?.owner_user_id === input.currentUserId)
  return input.agents
    .filter((agent) => isTransientAgentConversationStatus(input.statuses[agent.id] ?? 'offline'))
    .sort((a, b) => Number(isOwn(b.id)) - Number(isOwn(a.id)))
}
