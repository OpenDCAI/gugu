import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import { applySessionAdmissionChanges, hasSessionAdmissionPreparation } from '../sessions/session-admission-preparation'
import { listAutomations } from './repo'

let active: Promise<Map<string, Error>> | null = null

/** Run outside scheduler tails. Applying a saved deletion waits for those
 * tails itself; calling it under a queue lock would wait on the same promise. */
export function prepareAgentScheduleChanges(): Promise<Map<string, Error>> {
  if (!hasSessionAdmissionPreparation()) return Promise.resolve(new Map())
  if (active) return active
  active = (async () => {
    const blocked = new Map<string, Error>()
    const sessions = new Set((await listAutomations()).flatMap(row => row.agentSessionId ? [row.agentSessionId] : []))
    await Promise.all([...sessions].map(async sessionId => {
      try { await withBoundedOperation(3000,() => new Error('PANEL_PREPARATION_TIMEOUT'),() => applySessionAdmissionChanges(sessionId)) }
      catch (error) { blocked.set(sessionId,error instanceof Error ? error : new Error('PANEL_SCHEDULE_PREPARATION_FAILED')) }
    }))
    return blocked
  })().finally(() => { active = null })
  return active
}
