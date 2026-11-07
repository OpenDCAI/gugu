import type { CredentialUseBinding } from '../session/main/core/browser/credential-use-contract'
import { PasswordFactWindow, PasswordPermissionError, passwordUnavailable, type LivePasswordFact } from './password-facts'
import { decidePasswordUsePermission, type PasswordPermissionCaller, type PasswordResourceAuthority } from './password-policy'
import { requirePasswordProtections, type PasswordExecutionMode, type PasswordProtectionFacts } from './password-readiness'
import { parsePermissionPolicy, type PermissionPolicy } from './rules'

export { PasswordPermissionError } from './password-facts'

export type PasswordPermissionTarget = Omit<CredentialUseBinding, 'requestId' | 'useId'>
export type PasswordPermissionCheck =
  | { stage: 'request'; target: PasswordPermissionTarget }
  | { stage: 'before_fill' | 'before_submit' | 'before_handoff'; target: CredentialUseBinding }
export interface PasswordPermissionReaders {
  readActor(signal: AbortSignal): Promise<LivePasswordFact<PasswordPermissionCaller>>
  readMode(caller: PasswordPermissionCaller, signal: AbortSignal): Promise<LivePasswordFact<PasswordExecutionMode>>
  resolveTarget(caller: PasswordPermissionCaller, check: PasswordPermissionCheck, signal: AbortSignal): Promise<LivePasswordFact<{
    authority: PasswordResourceAuthority; target: PasswordPermissionTarget | CredentialUseBinding
  }>>
  readPolicy(caller: PasswordPermissionCaller, signal: AbortSignal): Promise<LivePasswordFact<PermissionPolicy | null>>
  readProtections(caller: PasswordPermissionCaller, signal: AbortSignal): Promise<PasswordProtectionFacts>
}
/** Eligibility only. The caller STILL needs the existing person approval and unique submission claim. */
export interface PasswordPermissionGuard {
  readonly signal: AbortSignal
  readonly requiresPersonConfirmation: true
  assertCurrent(): void
}
export interface PasswordPermissionPort {
  revalidate(input: PasswordPermissionCheck, signal: AbortSignal): Promise<PasswordPermissionGuard>
}
const fields = { requestId: true, useId: true, accountId: true, installationId: true, agentId: true, sessionId: true,
  browserId: true, loginSurfaceId: true, loginSurfaceEpoch: true, documentId: true, frameId: true, formFingerprint: true,
  credentialId: true, credentialVersion: true, lockEpoch: true, origin: true, operation: true } satisfies Record<keyof CredentialUseBinding, true>
const bindingKeys = Object.keys(fields) as (keyof CredentialUseBinding)[]

/**
 * No production constructor/entrypoint is registered here. Missing readers or missing generation/
 * revocation evidence remain unavailable. Fixtures cannot be substituted for production wiring.
 * No approval state, capability, secret reader, generic JSONL record or permission-setting write.
 */
export class PasswordPermissionRevalidator implements PasswordPermissionPort {
  private readonly readers: Partial<PasswordPermissionReaders>
  constructor(readers: Partial<PasswordPermissionReaders> = {}) {
    const captured: Partial<PasswordPermissionReaders> = {}
    for (const key of ['readActor', 'readMode', 'resolveTarget', 'readPolicy', 'readProtections'] as const) {
      if (typeof readers[key] === 'function') Object.assign(captured, { [key]: readers[key]!.bind(readers) })
    }
    this.readers = Object.freeze(captured)
  }

  async revalidate(input: PasswordPermissionCheck, signal: AbortSignal): Promise<PasswordPermissionGuard> {
    const window = new PasswordFactWindow(signal)
    try {
      window.assertCurrent()
      const r = this.readers
      if (!r.readActor || !r.readMode || !r.resolveTarget || !r.readPolicy || !r.readProtections) throw passwordUnavailable()
      if (!['request', 'before_fill', 'before_submit', 'before_handoff'].includes(input.stage)) throw passwordUnavailable()
      const keys = input.stage === 'request' ? bindingKeys.filter(key => key !== 'requestId' && key !== 'useId') : bindingKeys
      if (!input.target || keys.some(key => typeof (input.target as CredentialUseBinding)[key] !== 'string'
        || !(input.target as CredentialUseBinding)[key].trim()) || input.target.operation !== 'login-submit') {
        throw new PasswordPermissionError('password_target_invalid')
      }
      if (input.stage === 'request' && ('requestId' in input.target || 'useId' in input.target)) throw new PasswordPermissionError('password_target_invalid')
      if (input.stage !== 'request' && input.target.requestId === input.target.useId) throw new PasswordPermissionError('password_target_invalid')
      const origin = new URL(input.target.origin)
      if (origin.protocol !== 'https:' || origin.origin !== input.target.origin) throw new PasswordPermissionError('password_target_invalid')
      const target = Object.freeze(Object.fromEntries(keys.map(key => [key, (input.target as CredentialUseBinding)[key]])))
      const stage = input.stage, originalTarget = input.target
      window.bind(() => {
        if (input.stage !== stage || input.target !== originalTarget
          || stage === 'request' && ('requestId' in input.target || 'useId' in input.target)
          || keys.some(key => (input.target as CredentialUseBinding)[key] !== target[key])) throw passwordUnavailable()
      })
      const check = Object.freeze({ stage, target }) as PasswordPermissionCheck
      const actor = window.capture(await window.read(s => r.readActor!(s)))
      if (!actor || [actor.ownerId, actor.subjectId, actor.sessionId, actor.installationId, actor.deviceId, actor.toolScope]
        .some(value => typeof value !== 'string' || !value.trim())) throw passwordUnavailable()
      const mode = window.capture(await window.read(s => r.readMode!(actor, s)))
      if (mode !== 'enforce') throw passwordUnavailable()
      const resolved = window.capture(await window.read(s => r.resolveTarget!(actor, check, s)))
      if (!resolved?.target || keys.some(key => (resolved.target as CredentialUseBinding)[key] !== target[key])
        || target.accountId !== actor.ownerId || target.installationId !== actor.installationId
        || target.agentId !== actor.subjectId || target.sessionId !== actor.sessionId) throw new PasswordPermissionError('password_target_invalid')
      requirePasswordProtections(window, await window.read(s => r.readProtections!(actor, s)))
      const policy = window.capture(await window.read(s => r.readPolicy!(actor, s)))
      if (!policy) throw passwordUnavailable()
      const decision = decidePasswordUsePermission({ caller: actor, resource: resolved.authority, policy: parsePermissionPolicy(policy) })
      if (decision.effect === 'deny') throw new PasswordPermissionError('password_permission_denied')
      if (decision.effect !== 'ask') throw passwordUnavailable()
      window.assertCurrent()
      return Object.freeze({ signal: window.signal, requiresPersonConfirmation: true as const, assertCurrent: window.assertCurrent })
    } catch (error) {
      window.fail()
      // Never propagate a provider's exception, cause or private error text to a caller.
      const code = error instanceof PasswordPermissionError
        && ['password_permission_unavailable', 'password_permission_denied', 'password_target_invalid'].includes(error.code)
        ? error.code : 'password_permission_unavailable'
      throw new PasswordPermissionError(code)
    }
  }
}
