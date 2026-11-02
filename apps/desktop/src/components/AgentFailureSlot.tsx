import { useCallback } from 'react'
import { readShellSlots } from '../lib/shellSlots'

export const AGENT_FAILURE_SLOT_PREFIX = 'agent-failure:'

/**
 * A task page's place for its agent's failed deliveries, above its composer: the shell draws the same failure bar a chat's
 * composer shows (AgentFailureSlotHost), reading the same command rows for every chat of this agent.
 */
export function AgentFailureSlot({ agentUserId }: { agentUserId: string }) {
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(`${AGENT_FAILURE_SLOT_PREFIX}${agentUserId}`, element), [agentUserId])
  return <div ref={ref} data-agent-failure-slot={agentUserId} className="pointer-events-auto" />
}
