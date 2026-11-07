/** The execution boundary deliberately carries no credentials or assistant
 * identity. Imported operations retain their original UUID and request hash. */
export type ConnectionEffect = {
  operationId: string
  requestHash: string
  revision: string
  resourceKey: string
  deviceId: string
  operation: 'remove' | 'save' | 'enable' | 'disable' | 'prepared' | 'error'
  data: Record<string, unknown>
  admissionId?: string
  validationError?: string
}
export type ConnectionEffectReceipt = { state: 'started' | 'applied' | 'refused'; requestHash: string; admissionId: string; errorCode?: string; authorityMode?: 'owner'; authorityEpoch?: string }
export type ConnectionEffectLedger = Record<string, ConnectionEffectReceipt>

export class ConnectionEffectRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ConnectionEffectRefused' }
}

/** A response lost after an effect must retry only its acknowledgement. A crash
 * between starting and recording the outcome requires review, never replay. */
export function createConnectionOperationApplication(input: {
  deviceId: string
  assertCurrent(): void | Promise<void>
  authorityEpoch?(): string | undefined
  load(): Promise<ConnectionEffectLedger>
  save(ledger: ConnectionEffectLedger): Promise<void>
  admit(effect: ConnectionEffect): Promise<string | null>
  apply(effect: ConnectionEffect): Promise<void>
  acknowledge(effect: ConnectionEffect, admissionId: string, errorCode: string | null): Promise<void>
}) {
  let tail: Promise<unknown> = Promise.resolve()
  async function execute(effect: ConnectionEffect) {
    await input.assertCurrent()
    if (effect.deviceId !== input.deviceId) throw new ConnectionEffectRefused('CONNECTION_DEVICE_MISMATCH')
    const ledger = await input.load()
    const receipt = ledger[effect.operationId]
    if (receipt && receipt.requestHash !== effect.requestHash) throw new ConnectionEffectRefused('CONNECTION_OPERATION_REUSED')
    if (receipt?.state === 'started' || !receipt && effect.admissionId) {
      await input.acknowledge(effect, receipt?.admissionId ?? effect.admissionId!, 'CONNECTION_OUTCOME_UNKNOWN')
      throw new ConnectionEffectRefused('CONNECTION_OUTCOME_UNKNOWN')
    }
    if (receipt) {
      await input.acknowledge(effect, receipt.admissionId, receipt.state === 'applied' ? null : receipt.errorCode!)
      return
    }
    const admissionId = await input.admit(effect)
    if (!admissionId) return
    await input.assertCurrent()
    const authorityEpoch = input.authorityEpoch?.(),authority = authorityEpoch === undefined ? {} : { authorityMode: 'owner' as const,authorityEpoch }
    ledger[effect.operationId] = { state: 'started', requestHash: effect.requestHash, admissionId,...authority }
    await input.save(ledger)
    await input.assertCurrent()
    try {
      await input.apply(effect)
      await input.assertCurrent()
    } catch (error) {
      if (!(error instanceof ConnectionEffectRefused)) {
        // Preserve "started" even if reporting the uncertainty also fails.
        await input.assertCurrent()
        await input.acknowledge(effect, admissionId, 'CONNECTION_OUTCOME_UNKNOWN')
        throw new ConnectionEffectRefused('CONNECTION_OUTCOME_UNKNOWN')
      }
      ledger[effect.operationId] = { state: 'refused', requestHash: effect.requestHash, admissionId, errorCode: error.code,...authority }
      await input.save(ledger)
      await input.assertCurrent()
      await input.acknowledge(effect, admissionId, error.code)
      return
    }
    ledger[effect.operationId] = { state: 'applied', requestHash: effect.requestHash, admissionId,...authority }
    await input.save(ledger)
    await input.assertCurrent()
    await input.acknowledge(effect, admissionId, null)
  }
  return { apply(effect: ConnectionEffect): Promise<void> {
    const result = tail.catch(() => undefined).then(() => execute(effect))
    tail = result
    return result
  } }
}
