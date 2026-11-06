import { createHmac, randomUUID } from 'node:crypto'
import type { AuditInput, CredentialReference, CredentialSummary } from './contracts'
import { VaultError } from './contracts'
import type { VaultPayload } from './schema'

type StoredCredential = VaultPayload['credentials'][number]
export interface ManagementRuntime {
  key: Buffer; epoch: string; payload: VaultPayload
  check(reference: CredentialReference): StoredCredential
  current(): void
  persist(payload: VaultPayload): Promise<void>
  record(event: AuditInput): Promise<string>
  cleanup: Promise<boolean>
}
const result = (operation: VaultPayload['operations'][number], epoch: string): CredentialSummary => ({
  reference: { id: operation.credentialId, version: operation.version, epoch }, origin: operation.origin, maskedAccount: '••••',
})
function receipt(operation: VaultPayload['operations'][number], action: 'add' | 'edit' | 'delete'): AuditInput {
  return { id: operation.auditId, action, source: 'local-person', outcome: 'completed',
    credential: { id: operation.credentialId, version: operation.version }, origin: operation.origin }
}
/** The encrypted operation ledger makes lost responses/restarts safe to retry under the original operation id. */
export async function saveCredential(runtime: ManagementRuntime, operationId: string, input: { origin: string; account: string; password: string }, previous?: CredentialReference): Promise<CredentialSummary> {
  const { key, epoch, payload } = runtime
  // The durable request binds the credential/version, while runtime.check separately validates
  // the current unlock epoch. A failed audit must not strand the operation after re-unlock.
  const base = previous ? { id: previous.id, version: previous.version } : undefined
  const digest = createHmac('sha256', key).update(JSON.stringify({ input, previous: base })).digest('hex')
  let operation = payload.operations.find(item => item.id === operationId)
  if (operation && (operation.kind !== 'save' || operation.digest !== digest)) throw new VaultError('INVALID_INPUT')
  const action = previous ? 'edit' : 'add'
  if (operation?.status === 'committed') { await runtime.record(receipt(operation, action)); return result(operation, epoch) }
  const old = previous ? runtime.check(previous) : undefined
  if (!await runtime.cleanup) throw new VaultError('UNAVAILABLE')
  runtime.current()
  if (!operation) {
    operation = { id: operationId, kind: 'save', status: 'pending', digest, credentialId: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, origin: input.origin, auditId: randomUUID() }
    payload.operations.push(operation)
    // Pending metadata contains no new account/password. A changed-body retry cannot reuse the id.
    await runtime.persist(payload)
  }
  await runtime.record({ id: operationId, action, source: 'local-person', outcome: 'pending', ...(old ? { credential: { id: old.id, version: old.version } } : {}), origin: input.origin })
  runtime.current()
  payload.credentials = [...payload.credentials.filter(item => item.id !== operation!.credentialId), { ...input, id: operation.credentialId, version: operation.version }]
  operation.status = 'committed'
  await runtime.persist(payload)
  await runtime.record(receipt(operation, action))
  return result(operation, epoch)
}
export async function deleteCredential(runtime: ManagementRuntime, operationId: string, reference: CredentialReference): Promise<void> {
  const { key, payload } = runtime
  const digest = createHmac('sha256', key).update(JSON.stringify({ id: reference.id, version: reference.version })).digest('hex')
  let operation = payload.operations.find(item => item.id === operationId)
  if (operation && (operation.kind !== 'delete' || operation.digest !== digest)) throw new VaultError('INVALID_INPUT')
  if (operation?.status === 'committed') { await runtime.record(receipt(operation, 'delete')); return }
  const old = runtime.check(reference)
  if (!await runtime.cleanup) throw new VaultError('UNAVAILABLE')
  runtime.current()
  if (!operation) {
    operation = { id: operationId, kind: 'delete', status: 'pending', digest, credentialId: old.id, version: old.version, origin: old.origin, auditId: randomUUID() }
    payload.operations.push(operation); await runtime.persist(payload)
  }
  await runtime.record({ id: operationId, action: 'delete', source: 'local-person', outcome: 'pending', credential: { id: old.id, version: old.version }, origin: old.origin })
  runtime.current(); payload.credentials = payload.credentials.filter(item => item.id !== old.id); operation.status = 'committed'
  await runtime.persist(payload); await runtime.record(receipt(operation, 'delete'))
}
