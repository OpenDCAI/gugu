import { ConnectionError,type ConnectionClient } from '@gugu/core/cloud/connections'
import type { ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
import type { ConnectionMetadataSnapshot } from './connection-metadata'
import type { ConnectionVerificationStore,ConnectionVerification } from './connection-verification'

/** Observe original UUIDs and retry only explicitly requested cancellation.
 * Missing replies retain confirmation; authorization/deletion is never replayed. */
export function createConnectionVerificationReader(input: {
  ledger: ConnectionVerificationStore; snapshot(): ConnectionMetadataSnapshot | undefined; deviceId?: string | null
  client: Pick<ConnectionClient,'operationStatus'>; assertCurrent(): void | Promise<void>
  cancel?(row: ConnectionVerification): Promise<ConnectionOperationStatus | null>
  changed?(): void
}) {
  let cursor = 0,previous: ConnectionVerification[] = []
  const observed = new Map<string,ConnectionOperationStatus>()
  function matches(operation: ConnectionMetadataSnapshot['application'][number],status: ConnectionOperationStatus) {
    return status.resourceKey !== null && operation.resourceKey === JSON.stringify([status.scopeKey,status.resourceKey])
      && operation.operation === status.operation && operation.deviceId === status.deviceId
  }
  function project(snapshot: ConnectionMetadataSnapshot): ConnectionMetadataSnapshot {
    try { previous = input.ledger.list() } catch { /* Display the last identities; new writes still require durable storage. */ }
    return { ...snapshot,verificationProtocol: 2,verification: previous.filter(row => row.scopeKey === 'platform' || !input.deviceId || row.deviceId === input.deviceId),
      application: snapshot.application.map(operation => {
        const status = observed.get(operation.operationId)
        return status && matches(operation,status) ? { ...operation,verificationOriginal: status.original,resolution: status.resolution,effective: status.effective,confirmation: status.confirmation } : operation
      }),
    }
  }
  async function refresh() {
    await input.assertCurrent()
    const local = input.ledger.list(),snapshot = input.snapshot(),application = snapshot ? project(snapshot).application : []
    const queue = new Map(local.filter(row => row.status?.effective.blocksNewOperations ?? true).map(row => [row.operationId,{ local: true,operation: undefined as ConnectionMetadataSnapshot['application'][number] | undefined }]))
    for (const operation of application) {
      if (typeof operation.operation !== 'string') continue
      if (queue.has(operation.operationId) || operation.effective?.blocksNewOperations === false
        || !['pending','started'].includes(operation.status) && operation.errorCode !== 'CONNECTION_OUTCOME_UNKNOWN'
        || !['save','remove','enable','disable'].includes(operation.operation)) continue
      const item = snapshot?.items.find(row => row.resource_key === operation.resourceKey)
      if (item?.source && typeof item.data.providerId === 'string' && typeof item.data.accountId === 'string')
        queue.set(operation.operationId,{ local: false,operation })
    }
    const candidates = [...queue],count = Math.min(candidates.length,16),errors: unknown[] = []
    let changed = false
    const pending = Array.from({ length: count },(_,index) => candidates[(cursor + index) % candidates.length]!)
    cursor = candidates.length ? (cursor + count) % candidates.length : 0
    async function read() {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const [operationId,target] = next
        try {
          await input.assertCurrent()
          let cancelError: unknown,resolved = false
          const record = target.local ? local.find(row => row.operationId === operationId) : undefined
          if (record?.cancelRequested && !record.status?.confirmation.cancelRequested) {
            try {
              if (!input.cancel) throw new ConnectionError('unsupported-device','CONNECTION_CANCELLATION_UNAVAILABLE')
              const cancelled = await input.cancel(record)
              await input.assertCurrent()
              if (cancelled !== null) { input.ledger.accept(operationId,cancelled); resolved = !cancelled.effective.blocksNewOperations }
            } catch (error) { cancelError = error }
          }
          const result = await input.client.operationStatus(operationId)
          await input.assertCurrent()
          if (result === null) { if (cancelError && !resolved) throw cancelError; continue }
          if (result.operationId !== operationId) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_MISMATCH')
          if (target.local) {
            input.ledger.accept(operationId,result)
            if (cancelError && result.effective.blocksNewOperations && !resolved) throw cancelError
          }
          else {
            if (!target.operation || !matches(target.operation,result)) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_MISMATCH')
            if (JSON.stringify(observed.get(operationId)) !== JSON.stringify(result)) changed = true
            observed.set(operationId,result)
            if (observed.size > 256) observed.delete(observed.keys().next().value!)
          }
        } catch (error) { errors.push(error) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(count,4) },read))
    if (changed) input.changed?.()
    if (errors.length) throw errors[0]
  }
  return { project,refresh }
}
