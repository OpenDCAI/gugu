import { localAgentForSession } from '../sessionpage/sessionpage-session-agent'
import { archiveSession } from './archiveSession'
import { stopExactSessionpageSession } from './session-orchestration'

/** Startup owns its process and an unbound new row, never an identity's durable task. */
export async function rollbackAgentSessionStartup(input: {
  projectId: string
  sessionId: string
  created: boolean
  started: boolean
}): Promise<void> {
  if (input.started) await stopExactSessionpageSession(input).catch(() => false)
  if (!input.created) return
  // Provision can throw after writing the binding. Read its SSOT even on failure;
  // deleting that row would emit session:deleted and reclaim the existing identity.
  if (await localAgentForSession(input.sessionId, process.env)) return
  await archiveSession(input.projectId, input.sessionId, { skipTransportStop: true })
}
