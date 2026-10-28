import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { colorOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { agentDisplayStatusText } from './agentStatusText'

export type GroupAgentStatusMember = string | {
  id: string
  account_status?: string | null
}

// 一格里只能放一个 agent 时,放最需要人看的那个:需要你 > 出错 > 在跑 > 后台在跑 > 在线 > 确认中 > 不在线 > 已移除。
// 与会话页侧栏、手机的「最需要你」同一个次序(core agentStatusUrgency:needs_user > error > working > idle)。
const GROUP_AGENT_STATUS_RANK: Record<AgentDisplayStatus, number> = {
  removed: 0,
  offline: 1,
  archived: 1,
  pending: 2,
  idle: 3,
  parked: 4,
  working: 5,
  error: 6,
  needs_user: 7,
}

export function groupAgentDisplayStatus(
  member: GroupAgentStatusMember,
  statuses: Readonly<Record<string, AgentDisplayStatus>>,
): AgentDisplayStatus {
  if (typeof member !== 'string' && member.account_status === 'removed') return 'removed'
  const id = typeof member === 'string' ? member : member.id
  return statuses[id] ?? 'pending'
}

// @@@group-agent-status (#33) - a group's glanceable dot is the total aggregate of its agent members.
export function aggregateGroupAgentStatus(
  agentMembers: readonly GroupAgentStatusMember[] | undefined,
  statuses: Readonly<Record<string, AgentDisplayStatus>>,
): AgentDisplayStatus | undefined {
  if (!agentMembers?.length) return undefined
  // Resolved activity remains most informative. Pending outranks terminally quiet states so an
  // unknown member never makes the whole group claim offline before its first snapshot arrives.
  let best: AgentDisplayStatus | undefined
  for (const member of agentMembers) {
    const status = groupAgentDisplayStatus(member, statuses)
    if (!best || GROUP_AGENT_STATUS_RANK[status] > GROUP_AGENT_STATUS_RANK[best]) best = status
  }
  return best
}

export function groupAgentStatusIndicatorProps(
  agentMembers: readonly GroupAgentStatusMember[] | undefined,
  statuses: Readonly<Record<string, AgentDisplayStatus>>,
) {
  const status = aggregateGroupAgentStatus(agentMembers, statuses)
  if (!status) return undefined
  const label = agentDisplayStatusText(status)
  const color = colorOfDisplayStatus(status) ?? 'var(--agent-tone-muted)'
  return {
    role: 'img' as const,
    'data-agent-display-status': status,
    'aria-label': label,
    title: label,
    style: status === 'needs_user'
      ? {
          width: 8,
          height: 8,
          background: 'transparent',
          color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }
      : { width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 },
  }
}
