/** Durable assistant App state. No device connection or wake action belongs here. */
export type AssistantPanelDomain = 'tasks' | 'schedules' | 'memory' | 'personality' | 'integrations'
  | 'voice-notes' | 'capabilities' | 'device-notes' | 'files' | 'skills'
export type AssistantPanelOperation = 'save' | 'remove' | 'enable' | 'disable' | 'prepared' | 'error'
export type AssistantPanelItem = {
  assistant_user_id: string; owner_user_id: string; domain: AssistantPanelDomain; resource_key: string
  device_id: string | null; revision: string; data: Record<string, unknown>
  body_item_id: string | null; body_sha256: string | null; deleted_at: string | null
  observed_at: string | null; updated_at: string; stale_at?: string | null
}
export type AssistantPanelChange = {
  operation_id: string; revision: string; assistant_user_id: string; owner_user_id: string
  domain: string; resource_key: string; device_id: string | null; operation: AssistantPanelOperation | 'notice'
  payload: Record<string, unknown>; status: 'pending' | 'failed' | 'applied'; error_code: string | null
}
export type AssistantPanelSnapshot = {
  version: 1; revision: string; items: AssistantPanelItem[]
  application: { operationId: string; revision: string; domain: string; resourceKey: string; status: 'pending' | 'failed'; errorCode: string | null }[]
}
export type AssistantPanelCommit = {
  operationId: string; domain: AssistantPanelDomain; key: string; expectedRevision: string
  operation: AssistantPanelOperation; data?: Record<string, unknown>; body?: { itemId: string; sha256: string }
  deviceId?: string | null; runtimeInstanceId?: string | null
}
export type AssistantPanelReceipt = { operationId: string; revision: string; status: 'pending' | 'failed' | 'applied' | 'superseded' }
export type AssistantPanelNotice = {
  operationId: string; resource: string; operation: 'created' | 'edited' | 'removed' | 'saved'; id: string
  deviceId?: string; section?: string; before?: object; after?: object
}
export type AssistantPanelTransport = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string; code?: string } | null
}>

export class AssistantPanelError extends Error {
  constructor(readonly code: string, message: string, readonly resourceKey?: string, readonly domain?: string) { super(message); this.name = 'AssistantPanelError' }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const domains: readonly string[] = ['tasks','schedules','memory','personality','integrations','voice-notes','capabilities','device-notes','files','skills']
const invalid = (): never => { throw new AssistantPanelError('invalid-response','Assistant panel data could not be read') }

export function parseAssistantPanelSnapshot(value: unknown, ownerId: string, assistantId: string): AssistantPanelSnapshot {
  if (!record(value) || value.version !== 1 || !revision(value.revision) || !Array.isArray(value.items) || !Array.isArray(value.application)) return invalid()
  for (const item of value.items) {
    if (!record(item) || item.assistant_user_id !== assistantId || item.owner_user_id !== ownerId
      || !domains.includes(String(item.domain)) || typeof item.resource_key !== 'string' || !revision(item.revision) || !record(item.data)
      || !nullableString(item.device_id) || !nullableString(item.body_item_id) || !nullableString(item.body_sha256)
      || item.stale_at !== undefined && !nullableString(item.stale_at)
      || !nullableString(item.deleted_at) || !nullableString(item.observed_at) || typeof item.updated_at !== 'string'
      || (item.body_item_id !== null && item.body_sha256 === null)
      || (typeof item.body_sha256 === 'string' && !/^[0-9a-f]{64}$/.test(item.body_sha256))) return invalid()
  }
  if (new Set(value.items.map(item => `${item.domain}\0${item.resource_key}`)).size !== value.items.length) return invalid()
  for (const application of value.application) {
    if (!record(application) || !revision(application.revision) || typeof application.operationId !== 'string'
      || typeof application.domain !== 'string' || typeof application.resourceKey !== 'string'
      || !['pending','failed'].includes(String(application.status)) || !nullableString(application.errorCode)) return invalid()
  }
  return value as AssistantPanelSnapshot
}

export function assistantPanelItem(snapshot: AssistantPanelSnapshot, domain: AssistantPanelDomain, key: string): AssistantPanelItem | undefined {
  return snapshot.items.find(item => item.domain === domain && item.resource_key === key && !item.deleted_at)
}

/** Missing preparation and a successful empty read are different facts. */
export function assistantPanelCollection(snapshot: AssistantPanelSnapshot, domain: AssistantPanelDomain, deviceId?: string) {
  const key = deviceId ? `__collection__:${deviceId}` : '__collection__'
  const marker = assistantPanelItem(snapshot,domain,key)
  const items = snapshot.items.filter(item => item.domain === domain && !item.deleted_at
    && item.resource_key !== '__collection__' && !item.resource_key.startsWith('__collection__:')
    && (!deviceId || item.device_id === deviceId))
  if (marker && marker.data.state !== 'ready' && marker.data.state !== 'error') return invalid()
  return { items, state: marker?.stale_at || marker?.data.state === 'error' ? 'error' as const
    : marker?.data.state === 'ready' ? 'ready' as const : 'unprepared' as const }
}

export function createAssistantPanelClient(transport: AssistantPanelTransport, accountId: () => string | null) {
  async function request<T>(assistant: string, name: string, args: Record<string, unknown>, parse: (data: unknown, owner: string) => T): Promise<T> {
    const owner = accountId()
    if (!owner) throw new AssistantPanelError('signed-out','Not signed in')
    const answer = await transport(name,{ p_assistant: assistant,...args })
    if (accountId() !== owner) throw new AssistantPanelError('account-changed','Assistant panel account changed')
    if (answer.error) throw new AssistantPanelError(answer.error.code ?? 'unavailable',answer.error.message)
    return parse(answer.data,owner)
  }
  const receipt = (data: unknown): AssistantPanelReceipt => {
    if (!record(data) || typeof data.operationId !== 'string' || !revision(data.revision)
      || !['pending','failed','applied','superseded'].includes(String(data.status))) return invalid()
    return data as AssistantPanelReceipt
  }
  return {
    snapshot: (assistant: string) => request(assistant,'assistant_panel_snapshot',{},(data,owner) => parseAssistantPanelSnapshot(data,owner,assistant)),
    resource: (assistant: string, domain: AssistantPanelDomain, key: string) => request(assistant,'assistant_panel_resource',{
      p_domain: domain,p_resource_key: key,
    },(data,owner) => {
      if (!record(data) || data.version !== 1 || !('item' in data)) return invalid()
      if (data.item === null) return null
      return parseAssistantPanelSnapshot({ version: 1,revision: '0',items: [data.item],application: [] },owner,assistant).items[0]!
    }),
    notice: (assistant: string, notice: AssistantPanelNotice) => request(assistant,'assistant_panel_notice',{ p_notice: notice },receipt),
    commit: (assistant: string, change: AssistantPanelCommit) => request(assistant,'assistant_panel_commit',{
      p_operation_id: change.operationId,p_domain: change.domain,p_resource_key: change.key,p_expected_revision: change.expectedRevision,
      p_operation: change.operation,p_data: change.data ?? {},p_body_item_id: change.body?.itemId ?? null,p_body_sha256: change.body?.sha256 ?? null,
      p_device_id: change.deviceId ?? null,p_runtime_instance_id: change.runtimeInstanceId ?? null,
    },receipt),
    pending: (assistant: string, instance: string) => request(assistant,'assistant_panel_pending',{ p_runtime_instance_id: instance },(data,owner) => {
      if (!record(data) || !revision(data.revision) || !Array.isArray(data.changes) || !Array.isArray(data.notices)) return invalid()
      for (const change of [...data.changes,...data.notices]) {
        if (!record(change) || change.assistant_user_id !== assistant || change.owner_user_id !== owner
          || !revision(change.revision) || typeof change.operation_id !== 'string' || typeof change.domain !== 'string'
          || typeof change.resource_key !== 'string' || !record(change.payload) || !nullableString(change.device_id)
          || !['save','remove','enable','disable','prepared','error','notice'].includes(String(change.operation))
          || !['pending','failed'].includes(String(change.status)) || !nullableString(change.error_code)) return invalid()
      }
      if (data.changes.some(change => change.operation === 'notice') || data.notices.some(change => change.operation !== 'notice')) return invalid()
      return data as { revision: string; changes: AssistantPanelChange[]; notices: AssistantPanelChange[] }
    }),
    ack: (assistant: string, instance: string, operationId: string, errorCode: string | null = null) => request(assistant,'assistant_panel_ack',{
      p_runtime_instance_id: instance,p_operation_id: operationId,p_error_code: errorCode,
    },receipt),
    admit: (assistant: string, instance: string, head: string) => request(assistant,'assistant_panel_admit',{
      p_runtime_instance_id: instance,p_expected_revision: head,
    },data => {
      if (!record(data) || typeof data.admitted !== 'boolean' || !revision(data.revision)) return invalid()
      return data as { admitted: boolean; revision: string; domain?: string; resourceKey?: string; errorCode?: string | null }
    }),
  }
}
export type AssistantPanelClient = ReturnType<typeof createAssistantPanelClient>
