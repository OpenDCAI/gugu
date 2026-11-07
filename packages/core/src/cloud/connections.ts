/** Owner connection metadata. Credentials and third-party authorization stay in
 * their existing stores/services; this protocol never accepts an assistant ID. */
export type ConnectionTransport = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string; code?: string } | null; status?: number
}>
export type ConnectionItem = {
  scopeKey: string; resourceKey: string; deviceId: string | null; revision: string
  data: Record<string, unknown>; publicMetadata: Record<string, unknown> | null
  document: string | null; bodySha256: string | null; deletedAt: string | null
  staleAt: string | null; observedAt: string | null; updatedAt: string
}
export type ConnectionApplication = Omit<ConnectionChange, 'payload'>
export type ConnectionAuthority = {
  version: 1; mode: 'legacy' | 'owner'; epoch: string; phase: 'stable' | 'quiescing'; acceptingNewOperations: boolean
}

export type ConnectionSnapshot = { version: 1; revision: string } & (
  { state: 'ready'; items: ConnectionItem[]; application: ConnectionApplication[] }
  | { state: 'not-ready'; items: ConnectionItem[] | null; application: ConnectionApplication[] | null }
)
export type ConnectionOperation = 'save' | 'remove' | 'enable' | 'disable' | 'prepared' | 'error'
export type ConnectionChange = {
  operationId: string; requestHash: string; scopeKey: string; resourceKey: string; deviceId: string | null
  revision: string; expectedItemRevision: string; operation: ConnectionOperation; payload: Record<string, unknown>
  status: 'pending' | 'started' | 'failed'; errorCode: string | null; terminal: boolean; admissionId: string | null; startedAt: string | null
}
export type ConnectionReceipt = {
  operationId: string; revision: string; status: 'pending' | 'failed' | 'applied' | 'superseded'; scopeKey: string; resourceKey: string
}
export type ConnectionCommit = {
  operationId: string; scopeKey: string; resourceKey: string | null; expectedRevision: string | null; operation: ConnectionOperation
  data?: Record<string, unknown>; document?: string | null; deviceId?: string | null
  runtimeInstanceId?: string | null; recreationId?: string | null
}
export type NativeConnectionAuthorization = Pick<ConnectionCommit,'operationId' | 'scopeKey' | 'resourceKey' | 'expectedRevision'> & {
  authorityEpoch: string; recreationId: string; providerId: string; accountId: string
}
export type NativeConnectionAuthorizationBatch = {
  authorityEpoch: string; operationId: string; recreationId: string; providerId: string; operations: { operationId: string; accountId: string }[]
}
export type ConnectionBatchReceipt = { operationId: string; revision: string; receipts: ConnectionReceipt[] }
export type ConnectionRecreation = {
  recreationId: string; operationId: string; expectedItemRevision: string | null; revision: string; expiresAt: string
}
export type ConnectionAdmission = {
  admitted: boolean; revision: string; operationId?: string; operationRevision?: string; requestHash?: string
  admissionId?: string; reason?: string; domain?: 'integrations'; resourceKey?: string; errorCode?: string | null
}
export type ConnectionAcknowledgement = Omit<ConnectionReceipt, 'scopeKey' | 'resourceKey'> & {
  admissionId: string; status: 'applied' | 'failed'; errorCode: string | null; terminal: boolean
}
export type PlatformConnectionReceipt = ConnectionAcknowledgement & { scopeKey: 'platform'; resourceKey: string }

export function parsePlatformConnectionReceipt(value: unknown, operationId: string): PlatformConnectionReceipt {
  parseReceipt(value,operationId)
  if (!object(value) || value.scopeKey !== 'platform' || typeof value.resourceKey !== 'string' || !value.resourceKey
    || !uuid(value.admissionId) || !['applied','failed'].includes(String(value.status))
    || !nullableString(value.errorCode) || typeof value.terminal !== 'boolean') return invalid()
  return value as PlatformConnectionReceipt
}

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = 'ConnectionError' }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const invalid = (): never => { throw new ConnectionError('invalid-response', 'CONNECTION_RESPONSE_INVALID') }
const operations: readonly string[] = ['save','remove','enable','disable','prepared','error']
const scope = (value: unknown) => typeof value === 'string' && (value === 'platform' || value.startsWith('device:') && value.length > 7)
const publicFields = new Set(['version','providerId','accountId','isDefault','connectedAt','updatedAt','host','login','avatarUrl','credentialSource','displayName'])
const dataFields = new Set(['providerId','accountId','displayName','description','configured','isDefault','checkResult','checkedAt','permission','enabled','catalog','state','schemaVersion','itemCount'])
function publicData(value: unknown, fields: Set<string>): value is Record<string, unknown> {
  return object(value) && Object.entries(value).every(([key, field]) => fields.has(key) && (key === 'catalog'
    ? object(field) && typeof field.categoryId === 'string' && Object.keys(field).every(key => key === 'categoryId' || key === 'aliases')
      && (field.aliases === undefined || Array.isArray(field.aliases) && field.aliases.every(alias => typeof alias === 'string'))
    : field === null || ['string','boolean'].includes(typeof field) || typeof field === 'number' && Number.isFinite(field)))
}
function parseItem(value: unknown): ConnectionItem {
  if (!object(value) || !scope(value.scopeKey) || typeof value.resourceKey !== 'string' || !value.resourceKey || !revision(value.revision)
    || !nullableString(value.deviceId) || (value.scopeKey === 'platform' ? value.deviceId !== null : value.scopeKey !== `device:${value.deviceId}`)
    || !publicData(value.data, dataFields) || value.publicMetadata !== null && !publicData(value.publicMetadata, publicFields)
    || !nullableString(value.document) || value.bodySha256 !== null && !digest(value.bodySha256)
    || value.document !== null && value.bodySha256 === null || !nullableString(value.deletedAt) || !nullableString(value.staleAt)
    || !nullableString(value.observedAt) || typeof value.updatedAt !== 'string') return invalid()
  return value as ConnectionItem
}
function parseApplication(value: unknown): ConnectionApplication {
  if (!object(value) || !uuid(value.operationId) || !scope(value.scopeKey) || typeof value.resourceKey !== 'string' || !value.resourceKey
    || !revision(value.revision) || !['pending','started','failed'].includes(String(value.status))
    || !digest(value.requestHash) || !revision(value.expectedItemRevision) || !operations.includes(String(value.operation))
    || !nullableString(value.deviceId) || (value.scopeKey === 'platform' ? value.deviceId !== null : value.scopeKey !== `device:${value.deviceId}`)
    || !nullableString(value.startedAt) || value.admissionId !== null && !uuid(value.admissionId)
    || value.status === 'started' && (value.admissionId === null || value.startedAt === null)
    || !nullableString(value.errorCode) || typeof value.terminal !== 'boolean') return invalid()
  return value as ConnectionApplication
}
export function parseConnectionSnapshot(value: unknown): ConnectionSnapshot {
  if (!object(value) || value.version !== 1 || !['not-ready','ready'].includes(String(value.state)) || !revision(value.revision)
    || !Array.isArray(value.items) && !(value.state === 'not-ready' && value.items === null)
    || !Array.isArray(value.application) && !(value.state === 'not-ready' && value.application === null)) return invalid()
  const items = value.items === null ? null : (value.items as unknown[]).map(parseItem)
  const application = value.application === null ? null : (value.application as unknown[]).map(parseApplication)
  if (items && new Set(items.map(item => JSON.stringify([item.scopeKey,item.resourceKey]))).size !== items.length
    || application && new Set(application.map(change => change.operationId)).size !== application.length) return invalid()
  return { version: 1,state: value.state,revision: value.revision,items,application } as ConnectionSnapshot
}
function parseReceipt(value: unknown, operationId: string): Omit<ConnectionReceipt, 'scopeKey' | 'resourceKey'> {
  if (!object(value) || value.operationId !== operationId || !revision(value.revision)
    || !['pending','failed','applied','superseded'].includes(String(value.status))) return invalid()
  return value as Omit<ConnectionReceipt, 'scopeKey' | 'resourceKey'>
}
function parseChange(value: unknown): ConnectionChange {
  parseApplication(value)
  if (!object(value) || !digest(value.requestHash) || !revision(value.expectedItemRevision) || !operations.includes(String(value.operation))
    || !object(value.payload) || !nullableString(value.deviceId) || !nullableString(value.startedAt)
    || value.admissionId !== null && !uuid(value.admissionId)) return invalid()
  return value as ConnectionChange
}

export function createConnectionClient(transport: ConnectionTransport, accountId: () => string | null) {
  async function request<T>(name: string, args: Record<string, unknown>, parse: (value: unknown) => T | Promise<T>): Promise<T> {
    const owner = accountId()
    if (!owner) throw new ConnectionError('signed-out','CONNECTION_SIGNED_OUT')
    let response: Awaited<ReturnType<ConnectionTransport>>
    try { response = await transport(name,args) }
    catch (error) {
      if (accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
      if (error instanceof ConnectionError) throw error
      throw new ConnectionError('transport-failed','CONNECTION_TRANSPORT_FAILED')
    }
    if (accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    if (response.error) throw new ConnectionError(response.error.code ?? 'unavailable',response.error.message,response.status)
    const result = await parse(response.data)
    if (accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    return result
  }
  return {
    authority: () => request('connection_authority',{},value => {
      if (!object(value) || value.version !== 1 || !['legacy','owner'].includes(String(value.mode)) || !revision(value.epoch)
        || !['stable','quiescing'].includes(String(value.phase)) || typeof value.acceptingNewOperations !== 'boolean'
        || value.phase === 'quiescing' && value.acceptingNewOperations) return invalid()
      return value as ConnectionAuthority
    }),
    snapshot: (deviceId: string | null = null) => request('connection_snapshot',{ p_device_id: deviceId },parseConnectionSnapshot),
    resource: (scopeKey: string, resourceKey: string) => request('connection_resource',{ p_scope_key: scopeKey,p_resource_key: resourceKey },async value => {
      if (!object(value) || value.version !== 1 || !['not-ready','ready'].includes(String(value.state)) || !revision(value.revision) || !('item' in value)) return invalid()
      const item = value.item === null ? null : parseItem(value.item)
      if (item && (item.scopeKey !== scopeKey || item.resourceKey !== resourceKey)) return invalid()
      if (item?.document !== null && item?.document !== undefined) {
        const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(item.document))
        const actual = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('')
        if (actual !== item.bodySha256) throw new ConnectionError('body-changed','CONNECTION_DOCUMENT_CHANGED')
      }
      return { version: 1 as const,state: value.state as ConnectionSnapshot['state'],revision: value.revision,item }
    }),
    commit: (change: ConnectionCommit) => request('connection_commit',{
      p_operation_id: change.operationId,p_scope_key: change.scopeKey,p_resource_key: change.resourceKey,p_expected_revision: change.expectedRevision,
      p_operation: change.operation,p_data: change.data ?? {},p_document: change.document ?? null,p_device_id: change.deviceId ?? null,
      p_runtime_instance_id: change.runtimeInstanceId ?? null,p_recreation_id: change.recreationId ?? null,
    },value => {
      const receipt = parseReceipt(value,change.operationId)
      if (!object(value) || value.scopeKey !== change.scopeKey || typeof value.resourceKey !== 'string' || !value.resourceKey
        || change.resourceKey !== null && value.resourceKey !== change.resourceKey) return invalid()
      return { ...receipt,scopeKey: value.scopeKey as string,resourceKey: value.resourceKey }
    }),
    commitBatch: (input: { operationId: string; recreationId: string; operations: { operationId: string; data: Record<string,unknown>; document: string }[]; runtimeInstanceId?: string | null }) => request('connection_commit_batch',{
      p_operation_id: input.operationId,p_recreation_id: input.recreationId,p_operations: input.operations,p_runtime_instance_id: input.runtimeInstanceId ?? null,
    },value => {
      if (!object(value) || value.operationId !== input.operationId || !revision(value.revision) || !Array.isArray(value.receipts)
        || value.receipts.length !== input.operations.length) return invalid()
      const expected = new Set(input.operations.map(row => row.operationId))
      const receipts = value.receipts.map(entry => {
        if (!object(entry) || typeof entry.operationId !== 'string' || !expected.delete(entry.operationId)) return invalid()
        const receipt = parseReceipt(entry,entry.operationId)
        if (!object(entry) || !scope(entry.scopeKey) || typeof entry.resourceKey !== 'string' || !entry.resourceKey) return invalid()
        return { ...receipt,scopeKey: entry.scopeKey as string,resourceKey: entry.resourceKey }
      })
      if (expected.size || new Set(receipts.map(row => JSON.stringify([row.scopeKey,row.resourceKey]))).size !== receipts.length) return invalid()
      return { operationId: input.operationId,revision: value.revision,receipts }
    }),
    pending: (runtimeInstanceId: string) => request('connection_pending',{ p_runtime_instance_id: runtimeInstanceId },value => {
      if (!object(value) || value.version !== 1 || !revision(value.revision) || !Array.isArray(value.changes)) return invalid()
      const changes = value.changes.map(parseChange)
      if (new Set(changes.map(change => change.operationId)).size !== changes.length) return invalid()
      return { version: 1 as const, revision: value.revision, changes }
    }),
    admit: (runtimeInstanceId: string, expectedHeadRevision: string, operationId: string | null = null) => request('connection_admit',{
      p_runtime_instance_id: runtimeInstanceId,p_expected_revision: expectedHeadRevision,p_operation_id: operationId,
    },value => {
      if (!object(value) || typeof value.admitted !== 'boolean' || !revision(value.revision)) return invalid()
      if (operationId && (value.operationId !== operationId || value.admitted && (!uuid(value.admissionId) || !revision(value.operationRevision) || !digest(value.requestHash))
        || !value.admitted && !['already-started','terminal','superseded','outcome-unknown'].includes(String(value.reason)))) return invalid()
      return value as ConnectionAdmission
    }),
    ack: (runtimeInstanceId: string, operationId: string, admissionId: string, errorCode: string | null = null, terminal = false) => request('connection_ack',{
      p_runtime_instance_id: runtimeInstanceId,p_operation_id: operationId,p_admission_id: admissionId,p_error_code: errorCode,p_terminal: terminal,
    },value => {
      parseReceipt(value,operationId)
      if (!object(value) || value.admissionId !== admissionId || !['applied','failed'].includes(String(value.status)) || !nullableString(value.errorCode) || typeof value.terminal !== 'boolean') return invalid()
      return value as ConnectionAcknowledgement
    }),
    recreateBegin: (input: { operationId: string; scopeKey: string; resourceKey: string | null; expectedRevision: string | null; deviceId?: string | null; providerId?: string | null; expectedHeadRevision?: string | null }) => request('connection_recreate_begin',{
      p_operation_id: input.operationId,p_scope_key: input.scopeKey,p_resource_key: input.resourceKey,p_expected_revision: input.expectedRevision,p_device_id: input.deviceId ?? null,p_provider_id: input.providerId ?? null,p_expected_head_revision: input.expectedHeadRevision ?? null,
    },value => {
      if (!object(value) || value.operationId !== input.operationId || !uuid(value.recreationId) || value.expectedItemRevision !== input.expectedRevision || !revision(value.revision) || typeof value.expiresAt !== 'string') return invalid()
      return value as ConnectionRecreation
    }),
  }
}
export type ConnectionClient = ReturnType<typeof createConnectionClient>
