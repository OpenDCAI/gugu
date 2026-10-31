// After confirmed identity deletion: attempt cancellation, release the local binding,
// then remove its task/history. Cleanup errors are logged by the host; they do not
// change the renderer's identity-deletion receipt.
import { releaseAgentLocalFootprint, sessionpageSessionIdForAgent } from './agent-local-footprint'
import type { ReleasedAgentLocalFootprint } from './agent-local-footprint'
import { cancelAgentInFlightTurn } from './agent-turn-cancel'

export interface OwnerAgentDeletionDeps {
  /** 注入点只为单测;生产走真实实现。 */
  sessionIdForAgent?: (agentUserId: string) => Promise<string>
  cancelInFlightTurn?: (agentUserId: string, sessionId: string) => Promise<boolean>
  releaseFootprint?: (agentUserId: string) => Promise<ReleasedAgentLocalFootprint>
  removeBoundSession: (sessionId: string) => Promise<void>
  env?: NodeJS.ProcessEnv
}

export interface OwnerAgentDeletionResult extends ReleasedAgentLocalFootprint {
  cancelledTurn: boolean
}

/** Cancellation failure does not skip local binding or task cleanup. */
export async function releaseDeletedOwnedAgent(
  agentUserId: string,
  deps: OwnerAgentDeletionDeps,
): Promise<OwnerAgentDeletionResult> {
  const env = deps.env ?? process.env
  const sessionIdFor = deps.sessionIdForAgent
    ?? ((id: string) => sessionpageSessionIdForAgent(id, env))
  const cancel = deps.cancelInFlightTurn ?? cancelAgentInFlightTurn
  const release = deps.releaseFootprint
    ?? ((id: string) => releaseAgentLocalFootprint({ agentUserId: id, identityRemoved: true, env }))

  const sessionId = await sessionIdFor(agentUserId)

  let cancelledTurn = false
  let cancelFailure: Error | null = null
  try {
    cancelledTurn = await cancel(agentUserId, sessionId)
  } catch (error) {
    cancelFailure = error as Error
  }

  const released = await release(agentUserId)
  if (released.sessionId) await deps.removeBoundSession(released.sessionId)
  if (cancelFailure) throw cancelFailure
  return { ...released, cancelledTurn }
}
