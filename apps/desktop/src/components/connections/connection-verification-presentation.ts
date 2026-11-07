import type { ConnectionMetadataSnapshot } from './connection-metadata'
import type { AssistantConnectedApp } from '../assistant/assistant-app-connections'
import type { ConnectionPreviousPresentation } from './connection-verification'

type Candidate = { key: string; confirming: boolean; preserveState?: true; previous?: ConnectionPreviousPresentation; revision: string | null; createdAt: number }
/** The receipt updates presentation only. Current account rows and tombstones
 * remain the source of connection state; historical success cannot rebuild them. */
export function connectionVerificationPresentation(snapshot: ConnectionMetadataSnapshot,provider: string,
  application = snapshot.application): Omit<Candidate,'revision' | 'createdAt'> | undefined {
  const items = snapshot.items.filter(row => row.data.providerId === provider)
  const keys = new Set(items.map(row => row.resource_key))
  const local = snapshot.verification?.filter(row => row.providerId === provider) ?? []
  const candidates: Candidate[] = []
  const add = (row: { operation: string; revision: string | null; resourceKey: string | null; createdAt: number;
    confirming: boolean; unknown: boolean; failed: boolean; cancelled?: boolean; previous?: ConnectionPreviousPresentation }) => {
    if (!row.confirming) {
      if (row.cancelled || !row.failed) return
      const current = items.find(item => item.resource_key === row.resourceKey)
      if (current && row.revision !== null && BigInt(current.revision) > BigInt(row.revision)) return
    }
    candidates.push({ key: row.cancelled ? 'cancelling' : row.unknown ? row.operation === 'remove' ? 'disconnectionUnknown' : 'authorizationUnknown'
      : row.confirming ? row.operation === 'remove' ? 'confirmingDisconnect' : 'confirmingAuthorization'
        : row.operation === 'remove' ? 'disconnectionFailed' : 'authorizationFailed',
    confirming: row.confirming,...(row.cancelled ? { preserveState: true as const,...(row.previous ? { previous: row.previous } : {}) } : {}),revision: row.revision,createdAt: row.createdAt })
  }
  for (const operation of application) {
    if (typeof operation.operation !== 'string') continue
    if (!keys.has(operation.resourceKey)) continue
    const record = local.find(row => row.operationId === operation.operationId)
    if (record?.status) continue
    const effective = operation.effective
    const unknown = (operation.verificationOriginal?.errorCode ?? operation.errorCode) === 'CONNECTION_OUTCOME_UNKNOWN' && (!effective || effective.state === 'confirming')
    add({ operation: operation.operation,revision: operation.revision,resourceKey: operation.resourceKey,createdAt: record?.createdAt ?? 0,
      confirming: effective?.blocksNewOperations ?? (operation.status === 'pending' || unknown),unknown,
      failed: effective ? effective.state === 'failed' : operation.status === 'failed',cancelled: record?.cancelRequested || operation.confirmation?.cancelRequested,previous: record?.previous })
  }
  for (const record of local) {
    if (!record.status && application.some(row => row.operationId === record.operationId && keys.has(row.resourceKey))) continue
    const status = record.status
    add({ operation: record.operation,revision: status?.revision ?? null,
      resourceKey: record.resourceKey === null ? null : JSON.stringify([record.scopeKey,record.resourceKey]),createdAt: record.createdAt,
      confirming: status?.effective.blocksNewOperations ?? true,unknown: status?.original.errorCode === 'CONNECTION_OUTCOME_UNKNOWN' && status.effective.state === 'confirming',
      failed: status?.effective.state === 'failed',cancelled: record.cancelRequested || status?.confirmation.cancelRequested,previous: record.previous })
  }
  const outstanding = candidates.filter(row => row.confirming)
  const latest = (outstanding.length ? outstanding : candidates).reduce<Candidate | undefined>((previous,row) => !previous
    || (row.revision !== null && previous.revision !== null ? BigInt(row.revision) > BigInt(previous.revision) : row.createdAt > previous.createdAt) ? row : previous,undefined)
  return latest ? { key: latest.key,confirming: latest.confirming,...(latest.preserveState ? { preserveState: true,...(latest.previous ? { previous: latest.previous } : {}) } : {}) } : undefined
}
export function withConnectionVerification(app: AssistantConnectedApp,presentation: { confirming: boolean; preserveState?: boolean; previous?: ConnectionPreviousPresentation },label: string): AssistantConnectedApp {
  return { ...app,state: presentation.preserveState ? presentation.previous?.state ?? app.state : presentation.confirming ? 'checking' : 'needsReauth',
    saved: app.saved || presentation.confirming,connectionBusy: presentation.confirming,connectionStatus: label }
}
