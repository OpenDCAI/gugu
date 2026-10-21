import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import type { MentionCandidate } from '@/lib/mention'

export type AgentStatusById = Record<string, AgentDisplayStatus>

export function mentionOptionStatusProps(member: MentionCandidate, statuses: AgentStatusById) {
  if (member.type !== 'agent') return {}
  return {
    'data-agent-status-surface': 'mention-option',
    'data-agent-id': member.id,
    'data-agent-display-status': statuses[member.id] ?? 'pending',
  }
}
