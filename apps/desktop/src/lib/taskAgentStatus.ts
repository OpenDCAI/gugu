import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { observedAgentPresence } from './agentPresenceMobx'

type TaskStatusSource =
  | { kind: 'agent'; agentUserId: string }
  | { kind: 'task'; reading: AgentStatusView | null; unseen: boolean; online: boolean }

/** An identified agent never falls back to the task directory or direct link. */
export function taskStatusPresentation(source: TaskStatusSource): AgentStatusPresentation | null {
  if (source.kind === 'agent') return observedAgentPresence(source.agentUserId).presentation
  // Identity-free tasks have no agent presence; retain the host's task reading.
  if (!source.online && source.reading?.status === 'working') return null
  return presentAgentStatus({ reading: source.reading, unseen: source.unseen })
}
