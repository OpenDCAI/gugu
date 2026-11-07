import { ConnectionError } from '@gugu/core/cloud/connections'
import { parseConnectionOperationStatus,type ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
import type { AssistantConnectedApp } from '../assistant/assistant-app-connections'

export type ConnectionPreviousPresentation = Pick<AssistantConnectedApp,'state' | 'saved'>

export type ConnectionVerification = {
  operationId: string; providerId: string; scopeKey: string; resourceKey: string | null; deviceId: string | null
  operation: 'save' | 'remove' | 'enable' | 'disable'; authorityEpoch: string; createdAt: number; status?: ConnectionOperationStatus
  cancelRequested?: boolean
  previous?: ConnectionPreviousPresentation
  submitted?: true
}
type StoragePort = Pick<Storage,'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
const PREFIX = 'gugu.connection-verification.v1:'
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new ConnectionError('invalid-response','CONNECTION_VERIFICATION_INVALID') }

/** Public request identities only. An unavailable durable store refuses a new
 * effect; it must not silently turn into an in-memory authorization journal. */
export function createConnectionVerification(input: {
  ownerId: string; epoch: string; accountId(): string | null; storage: StoragePort; changed(): void
}) {
  const prefix = PREFIX + JSON.stringify(input.ownerId) + ':'
  const current = () => { if (input.accountId() !== input.ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED') }
  function parse(raw: string,operationId: string): ConnectionVerification {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || value.version !== 1 || value.operationId !== operationId || !uuid(operationId)
      || typeof value.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.providerId)
      || typeof value.scopeKey !== 'string' || (value.scopeKey === 'platform' ? value.deviceId !== null : value.scopeKey !== `device:${value.deviceId}` || typeof value.deviceId !== 'string' || !value.deviceId)
      || value.resourceKey !== null && (typeof value.resourceKey !== 'string' || !value.resourceKey)
      || !['save','remove','enable','disable'].includes(String(value.operation)) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || typeof value.authorityEpoch !== 'string' || !/^\d+$/.test(value.authorityEpoch)
      || value.cancelRequested !== undefined && typeof value.cancelRequested !== 'boolean') return invalid()
    if (value.previous !== undefined && (!object(value.previous) || typeof value.previous.saved !== 'boolean'
      || !['checking','notConnected','connected','needsReauth','checkFailed','unverified','paused','retrying'].includes(String(value.previous.state)))) return invalid()
    if (value.submitted !== undefined && value.submitted !== true) return invalid()
    const status = value.status === undefined ? undefined : parseConnectionOperationStatus(value.status,operationId)
    if (status && (status.scopeKey !== value.scopeKey || status.deviceId !== value.deviceId || status.operation !== value.operation
      || value.resourceKey !== null && status.resourceKey !== null && value.resourceKey !== status.resourceKey)) return invalid()
    return { operationId,providerId: value.providerId,scopeKey: value.scopeKey,resourceKey: value.resourceKey as string | null,
      deviceId: value.deviceId as string | null,operation: value.operation as ConnectionVerification['operation'],createdAt: value.createdAt,
      authorityEpoch: value.authorityEpoch,
      ...(value.previous ? { previous: { state: (value.previous as ConnectionPreviousPresentation).state,saved: (value.previous as ConnectionPreviousPresentation).saved } } : {}),...(value.submitted ? { submitted: true as const } : {}),
      ...(value.cancelRequested === true ? { cancelRequested: true } : {}),...(status ? { status } : {}) }
  }
  function read(operationId: string) {
    current()
    const raw = input.storage.getItem(prefix + operationId)
    current()
    return raw === null ? undefined : parse(raw,operationId)
  }
  function list() {
    current()
    const records: ConnectionVerification[] = []
    for (let index = 0; index < input.storage.length; index++) {
      const key = input.storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const record = read(key.slice(prefix.length))
      if (record) records.push(record)
    }
    return records
  }
  function save(record: ConnectionVerification) {
    current()
    const raw = JSON.stringify({ version: 1,...record }),key = prefix + record.operationId
    if (input.storage.getItem(key) === raw) return
    input.storage.setItem(key,raw)
    if (input.storage.getItem(key) !== raw) throw new ConnectionError('storage-unavailable','CONNECTION_VERIFICATION_NOT_SAVED')
    current(); input.changed()
  }
  return {
    list,read,
    begin(value: Omit<ConnectionVerification,'createdAt' | 'status' | 'cancelRequested' | 'authorityEpoch' | 'submitted'>) {
      const previous = read(value.operationId)
      if (previous) {
        if (previous.authorityEpoch !== input.epoch || previous.providerId !== value.providerId || previous.scopeKey !== value.scopeKey || previous.deviceId !== value.deviceId
          || previous.resourceKey !== value.resourceKey || previous.operation !== value.operation) return invalid()
        return previous
      }
      const records = list()
      if (records.some(row => row.providerId === value.providerId && row.scopeKey === value.scopeKey && (row.status?.effective.blocksNewOperations ?? true)))
        throw new ConnectionError('operation-pending','CONNECTION_APPLICATION_BUSY')
      if (records.length >= 128) {
        const removable = records.filter(row => row.status && !row.status.effective.blocksNewOperations).sort((a,b) => a.createdAt - b.createdAt)
        if (!removable.length) throw new ConnectionError('storage-unavailable','CONNECTION_VERIFICATION_FULL')
        input.storage.removeItem(prefix + removable[0]!.operationId)
      }
      const record = parse(JSON.stringify({ version: 1,...value,authorityEpoch: input.epoch,createdAt: Date.now() }),value.operationId)
      save(record); return record
    },
    markSubmitted(operationId: string) {
      const record = read(operationId)
      if (!record) return invalid()
      save({ ...record,submitted: true })
    },
    discardUnsubmitted(operationId: string) {
      const record = read(operationId)
      if (!record || record.submitted || record.status) return invalid()
      input.storage.removeItem(prefix + operationId)
      current(); input.changed()
    },
    bind(operationId: string,resourceKey: string | null) {
      const record = read(operationId)
      if (!record || record.resourceKey !== null && record.resourceKey !== resourceKey) return invalid()
      save({ ...record,resourceKey })
    },
    requestCancellation(operationId: string) {
      const record = read(operationId)
      if (!record) return invalid()
      save({ ...record,cancelRequested: true })
    },
    accept(operationId: string,value: ConnectionOperationStatus) {
      const record = read(operationId),status = parseConnectionOperationStatus(value,operationId)
      if (!record || status.scopeKey !== record.scopeKey || status.deviceId !== record.deviceId || status.operation !== record.operation
        || record.resourceKey !== null && status.resourceKey !== null && record.resourceKey !== status.resourceKey) return invalid()
      if (record.status?.original.errorCode === 'CONNECTION_OUTCOME_UNKNOWN' && JSON.stringify(status.original) !== JSON.stringify(record.status.original)) return invalid()
      if (record.status && !record.status.effective.blocksNewOperations) {
        if (status.effective.blocksNewOperations) return
        if (record.status.resolution && JSON.stringify(status.resolution) !== JSON.stringify(record.status.resolution)
          || record.status.original.errorCode === 'CONNECTION_OUTCOME_UNKNOWN' && JSON.stringify(status.original) !== JSON.stringify(record.status.original)) return invalid()
      }
      save({ ...record,resourceKey: status.resourceKey ?? record.resourceKey,status })
    },
  }
}
export type ConnectionVerificationStore = ReturnType<typeof createConnectionVerification>
