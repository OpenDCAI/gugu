import { useCallback, useSyncExternalStore } from 'react'
import { getAgentPresenceSnapshot, subscribeAgentPresence } from '../lib/agentPresenceStore'

/** Select only the stable harness fact, without deriving it from a name or online status. */
export function useAgentHarnessIdentity(agentId: string | undefined) {
  const subscribe = useCallback((notify: () => void) => agentId
    ? subscribeAgentPresence(agentId, notify)
    : () => {}, [agentId])
  const snapshot = useCallback(() => {
    if (!agentId) return 'unavailable' as const
    const state = getAgentPresenceSnapshot(agentId)
    if (!state?.payload) return state?.error ? 'unavailable' as const : 'pending' as const
    if (state.payload.accountStatus === 'removed') return 'removed' as const
    return state.payload.agentType ?? 'unavailable' as const
  }, [agentId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
