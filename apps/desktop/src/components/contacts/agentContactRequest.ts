import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'

export type AgentRequestState = 'available' | 'requesting' | 'requested' | 'joined'

export function commonGroupForAgent(agentId: string, groups: ContactGroupChat[]): ContactGroupChat | null {
  return groups.find((group) => group.member_user_ids?.includes(agentId)) ?? null
}

export function requestStateForAgent({
  agent,
  currentUserId,
  commonGroup,
  sentRequestIds,
  requestingAgentId,
}: {
  agent: ContactUser
  currentUserId?: string | null
  commonGroup: ContactGroupChat | null
  sentRequestIds: Set<string>
  requestingAgentId: string | null
}): AgentRequestState | null {
  if (!currentUserId || !agent.owner_user_id || agent.owner_user_id === currentUserId) return null
  if (commonGroup) return 'joined'
  if (requestingAgentId === agent.id) return 'requesting'
  if (sentRequestIds.has(agent.id)) return 'requested'
  return agent.agent_public ? 'available' : null
}
