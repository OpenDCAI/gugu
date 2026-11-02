import type { AgentProvision } from './types/agentProvision';

export const ASSISTANT_PROVISION_SELECT = 'agent_user_id,device_id,member_key,phase,created_at,agent:users!agent_provisions_agent_user_id_fkey(removed_at)';
type ProvisionIdentity = { removed_at: string | null };
export type AssistantProvisionRow = Pick<AgentProvision, 'agent_user_id' | 'device_id' | 'member_key' | 'phase' | 'created_at'> & {
  // Untyped PostgREST clients infer embedded relations as arrays. Accept either
  // representation, but require exactly one identity before trusting its state.
  agent: ProvisionIdentity | ProvisionIdentity[] | null;
};
export function provisionIdentityRemovedAt(row: Pick<AssistantProvisionRow, 'agent'>): string | null | undefined {
  const identity = Array.isArray(row.agent) ? row.agent.length === 1 ? row.agent[0] : null : row.agent;
  return identity?.removed_at;
}
export type AssistantPick = { agentId: string; deviceId: string };
const GONE_PHASES = new Set<AgentProvision['phase']>(['failed', 'cancelling', 'cancelled']);

/** Personal identity follows the latest live provision marker, independent of name or host. */
export function pickAssistant(rows: readonly AssistantProvisionRow[]): AssistantPick | null {
  const live = rows.filter(row => {
    if (row.member_key !== 'assistant' || !row.agent_user_id || GONE_PHASES.has(row.phase)) return false;
    // archive_user retains the identity and its provision for history. A stale
    // completed marker cannot resurrect a governed-removed personal assistant.
    const removedAt = provisionIdentityRemovedAt(row);
    if (removedAt === undefined) throw new Error('Could not verify the personal assistant identity');
    return removedAt === null;
  });
  live.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const top = live[0];
  return top?.agent_user_id ? { agentId: top.agent_user_id, deviceId: top.device_id } : null;
}
