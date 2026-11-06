import { randomUUID } from 'node:crypto'
import { anySignal } from '@gugu/core/shared/anySignal'
import type { AuditInput, AuditReceipt, CredentialUseResult, VaultBrowserSink, VaultUseBinding, VaultUseCapability, VaultUseControl } from './contracts'
import { VaultError } from './contracts'

interface SecretLease {
  account: Buffer; password: Buffer
  signal: AbortSignal
  assertCurrent(): void
  release(): void
}
/** Internal, fixed browser sink. Neither this function nor its lease is registered as a tool/API. */
export async function performCredentialUse(
  sink: VaultBrowserSink, capability: VaultUseCapability, binding: VaultUseBinding,
  prepare: (control: VaultUseControl) => Promise<SecretLease>,
  audit: (input: AuditInput, effectPossible: boolean) => Promise<AuditReceipt>,
): Promise<CredentialUseResult> {
  let lease: SecretLease | undefined, possibleEffect = false, auditFailed = false
  let status: CredentialUseResult['status'] = 'unavailable', keepObservationPaused = true
  const event = (outcome: AuditInput['outcome']): AuditInput => ({ id: randomUUID(), action: 'use', source: 'browser', outcome,
    agentId: binding.agentId, sessionId: binding.sessionId, requestId: binding.requestId, useId: binding.useId,
    origin: binding.origin, credential: { id: binding.credentialId, version: Number(binding.credentialVersion) } })
  let claimed = false
  try {
    const claim = sink.claimCredentialSink(capability, binding)
    claimed = true
    claim.assertCurrent()
    lease = await prepare(claim)
    const before = await audit(event('pending'), false)
    if (before.status !== 'recorded') { auditFailed = true; throw new VaultError('AUDIT_FAILED') }
    let submissionClaimed = false
    const assertCurrent = () => { lease!.assertCurrent(); claim.assertCurrent(); if (claim.signal.aborted || lease!.signal.aborted) throw new VaultError('CANCELLED') }
    const control: VaultUseControl = { signal: anySignal([claim.signal, lease.signal]), assertCurrent,
      claimSubmission() {
        assertCurrent()
        if (submissionClaimed) throw new VaultError('CANCELLED')
        claim.claimSubmission(); submissionClaimed = true
      } }
    assertCurrent()
    // Page input handlers may themselves cause an effect: filling already makes an outcome uncertain on failure.
    possibleEffect = true
    const result = await sink.fillAndSubmit(binding, lease, control)
    if (!['submitted_unconfirmed', 'login_confirmed', 'person_interaction_required', 'failed', 'uncertain'].includes(result)) throw new VaultError('UNAVAILABLE')
    status = result
  } catch { status = possibleEffect ? 'uncertain' : 'unavailable' }
  finally { lease?.release() }
  if (!claimed) return { status: 'unavailable', retry: false, keepObservationPaused: true }
  // Cleanup never resumes observation. The coordinator requires this result and the post-audit receipt.
  try { keepObservationPaused = (await sink.cleanup(binding.useId)).status !== 'cleaned' }
  catch { keepObservationPaused = true }
  if (auditFailed) return { status: possibleEffect ? 'uncertain' : 'unavailable', retry: false, keepObservationPaused: true }
  try {
    const after = await audit(event(status === 'unavailable' ? 'failed' : status), possibleEffect)
    if (after.status !== 'recorded') return { status: possibleEffect ? 'uncertain' : 'unavailable', retry: false, keepObservationPaused: true }
  } catch { return { status: possibleEffect ? 'uncertain' : 'unavailable', retry: false, keepObservationPaused: true } }
  return { status, retry: false, keepObservationPaused: keepObservationPaused || status === 'uncertain' }
}
