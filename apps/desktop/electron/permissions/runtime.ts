import { randomUUID } from 'node:crypto'
import { permissionOperation, type PermissionCaller } from './operation'
import { decidePermission, type PermissionDecision, type PermissionOperation, type PermissionPolicy } from './rules'
import { PrivatePermissionRecords } from './private-records'
import { filterPermissionResult } from './result-filter'

export interface PermissionSnapshot { policy: PermissionPolicy | null; knownSecrets?: readonly string[] }
export interface PermissionAttempt {
  execute: boolean
  decision: PermissionDecision
  refusal: { content: { type: 'text'; text: string }[]; isError: true }
  finish(value: unknown, failed: boolean): Promise<unknown>
}
const refusal = (code: string) => ({ content: [{ type: 'text' as const, text: code }], isError: true as const })

export class ServicePermissionRuntime {
  constructor(private readonly deps: {
    records: PrivatePermissionRecords
    readPolicy(caller: PermissionCaller, signal: AbortSignal, mode: 'observe' | 'enforce'): Promise<PermissionSnapshot | null>
    /** Canonical resource from the owning host dispatcher, including aliases/implicit targets. Never a model assertion. */
    resolveResource?(caller: PermissionCaller, operation: PermissionOperation, signal: AbortSignal,
      input: { name: string; args: unknown }): Promise<Readonly<Record<string, string>> | null>
    /** Payload-free diagnostic only; audit failures never enter chats or the model context in observation mode. */
    recordFailure?(): void
  }) {}
  private recordFailure(): void {
    try { this.deps.recordFailure?.() } catch { /* Diagnostics cannot change a tool's behavior. */ }
  }

  async begin(caller: PermissionCaller, name: string, args: unknown, signal: AbortSignal): Promise<PermissionAttempt> {
    let operation = permissionOperation(caller, name, args)
    // Only target-free capability/documentation discovery is safe without a host resource resolver.
    // Raw resource spellings (public numbers, UUIDs, implicit reply targets) are never canonical authority.
    let resourceVerified = operation.effect === 'discovery' && Object.keys(operation.resource).length === 1
      && operation.resource.session === caller.sessionId
    if (this.deps.resolveResource) {
      try {
        const resource = await this.deps.resolveResource(caller, operation, signal, { name, args })
        if (resource) { operation = { ...operation, resource }; resourceVerified = true }
      } catch { /* Unresolved resources cannot turn an allow into permission to execute. */ }
    }
    const verifyResource = (decision: PermissionDecision): PermissionDecision => decision.effect === 'allow' && !resourceVerified
      ? { ...decision, effect: 'ask', reason: 'resource_verification_required', source: 'boundary' } : decision
    const id = randomUUID()
    // A corrupt/unreadable switch cannot silently turn enforcement off.
    let enforcing = true
    let switchAvailable = true
    try { enforcing = await this.deps.records.enforcement(caller.ownerId) }
    catch { switchAvailable = false }
    let snapshot: PermissionSnapshot | null = null
    try { snapshot = await this.deps.readPolicy(caller, signal, enforcing ? 'enforce' : 'observe') } catch { /* Unknown authority fails closed below. */ }
    let decision = verifyResource(decidePermission({ operation, agentId: caller.subjectId, policy: switchAvailable ? snapshot?.policy ?? null : null }))
    let mode: 'enforce' | 'observe' = enforcing ? 'enforce' : 'observe'
    const record = async (phase: 'before' | 'after', outcome: Parameters<PrivatePermissionRecords['append']>[2]['outcome']) => {
      // No signed-in account: do not create records attributed to an outgoing/unknown account.
      if (!snapshot && !enforcing) return
      await this.deps.records.append(caller, operation, { id, phase, mode, decision, outcome })
    }
    let execute = !enforcing || decision.effect === 'allow'
    if (signal.aborted) execute = false
    try { await record('before', execute ? `would_${decision.effect}` : 'blocked') }
    catch {
      this.recordFailure()
      if (enforcing) { decision = decidePermission({ operation, agentId: caller.subjectId, policy: null }); execute = false }
    }
    // There is deliberately no approval parameter. The reviewed person-only approval UI is a later integration.
    const denied = refusal(signal.aborted ? 'request_cancelled' : decision.effect === 'ask' ? 'owner_confirmation_required' : `permission_denied: ${decision.reason}`)
    return {
      execute, decision, refusal: denied,
      finish: async (value, failed) => {
        let output = value
        // A failed switch read cannot prove observation is still active.
        let postEnforcing = true
        const mayHaveEffects = operation.effect !== 'read' && operation.effect !== 'discovery'
        let outcome: 'completed' | 'failed' | 'unknown' = failed ? mayHaveEffects ? 'unknown' : 'failed' : 'completed'
        try {
          const stillEnforcing = await this.deps.records.enforcement(caller.ownerId)
          postEnforcing = enforcing || stillEnforcing
          mode = postEnforcing ? 'enforce' : 'observe'
          const latest = await this.deps.readPolicy(caller, signal, mode)
          const after = verifyResource(decidePermission({ operation, agentId: caller.subjectId, policy: latest?.policy ?? null }))
          if (postEnforcing && (signal.aborted || after.effect !== 'allow')) {
            // The effect may already have occurred. Withhold the result, never retry or claim rollback.
            output = refusal('permission_changed_after_execution: effects_may_have_occurred; do_not_retry_automatically')
            outcome = 'unknown'
          } else if (postEnforcing) {
            output = failed ? refusal(mayHaveEffects ? 'tool_failed_after_execution: effects_may_have_occurred; do_not_retry_automatically' : 'tool_failed: details_withheld')
              : filterPermissionResult(value, [...(snapshot?.knownSecrets ?? []), ...(latest?.knownSecrets ?? [])])
          }
          decision = after
        } catch {
          if (postEnforcing) {
            mode = 'enforce'
            decision = decidePermission({ operation, agentId: caller.subjectId, policy: null })
            output = refusal('permission_unavailable_after_execution: effects_may_have_occurred; do_not_retry_automatically')
            outcome = 'unknown'
          }
        }
        try { await record('after', outcome) }
        catch {
          this.recordFailure()
          if (postEnforcing) output = refusal('permission_record_failed_after_execution: effects_may_have_occurred; do_not_retry_automatically')
        }
        return output
      },
    }
  }
}
