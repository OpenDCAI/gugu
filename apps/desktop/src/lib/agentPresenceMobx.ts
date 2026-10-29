import { createAtom, type IAtom } from 'mobx'
import {
  getAgentPresenceSnapshot,
  neverObservedAgentPresence,
  subscribeAgentPresence,
  type AgentPresenceState,
} from './agentPresenceStore'

// MobX only tracks the existing presence store. There is no second status map:
// every read returns that store's actual snapshot, and its subscription owns
// batching, reconciliation and account changes just as it does for React.
type Observation = { atom: IAtom; unsubscribe: (() => void) | null }
const observations = new Map<string, Observation>()

export function observedAgentPresence(agentUserId: string): AgentPresenceState {
  let observation = observations.get(agentUserId)
  if (!observation) {
    const entry: Observation = {
      atom: createAtom(
        `agent-presence:${agentUserId}`,
        () => {
          entry.unsubscribe = subscribeAgentPresence(agentUserId, () => entry.atom.reportChanged())
        },
        () => {
          entry.unsubscribe?.()
          entry.unsubscribe = null
          if (observations.get(agentUserId) === entry) observations.delete(agentUserId)
        },
      ),
      unsubscribe: null,
    }
    observations.set(agentUserId, entry)
    observation = entry
  }
  const tracked = observation.atom.reportObserved()
  const snapshot = getAgentPresenceSnapshot(agentUserId)
  // An imperative read is not a subscription and must retain no observer node.
  if (!tracked && !observation.unsubscribe) observations.delete(agentUserId)
  return snapshot ?? neverObservedAgentPresence(agentUserId)
}
