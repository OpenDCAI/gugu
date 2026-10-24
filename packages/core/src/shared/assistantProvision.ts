import type { AgentProvision } from './types/agentProvision';

export type AssistantProvisionRow = Pick<AgentProvision, 'agent_user_id' | 'device_id' | 'member_key' | 'phase' | 'created_at'>;
export type AssistantPick = { agentId: string; deviceId: string };
const GONE_PHASES = new Set<AgentProvision['phase']>(['failed', 'cancelling', 'cancelled']);

/** Personal identity follows the latest live provision marker, independent of name or host. */
export function pickAssistant(rows: readonly AssistantProvisionRow[]): AssistantPick | null {
  const live = rows.filter(row => row.member_key === 'assistant' && row.agent_user_id && !GONE_PHASES.has(row.phase));
  live.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const top = live[0];
  return top?.agent_user_id ? { agentId: top.agent_user_id, deviceId: top.device_id } : null;
}
