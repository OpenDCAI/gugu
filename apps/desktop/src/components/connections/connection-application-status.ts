import type { ConnectionMetadataSnapshot } from './connection-metadata'

/** Join the encoded owner/scope/resource identity, including retained tombstones. */
export function connectionApplicationStatus(snapshot: ConnectionMetadataSnapshot | undefined, provider: string,
  application: ConnectionMetadataSnapshot['application'] = snapshot?.application ?? []) {
  if (!snapshot) return undefined
  const keys = new Set(snapshot.items.filter(row => row.data.providerId === provider).map(row => row.resource_key))
  // The read adapter can supply effective receipt states without rewriting the original journal.
  // A removed operation alone never certifies the account: its published metadata still supplies health.
  const operations = application.filter(row => keys.has(row.resourceKey))
  const outstanding = operations.filter(row => row.status === 'pending' || row.errorCode === 'CONNECTION_OUTCOME_UNKNOWN')
  const latest = (outstanding.length ? outstanding : operations).reduce<typeof operations[number] | undefined>(
    (previous,row) => !previous || BigInt(row.revision) > BigInt(previous.revision) ? row : previous,undefined)
  if (!latest) return undefined
  const unknown = latest.errorCode === 'CONNECTION_OUTCOME_UNKNOWN'
  const confirming = latest.status === 'pending' || unknown
  if (unknown) return { key: latest.operation === 'remove' ? 'disconnectionUnknown' : 'authorizationUnknown',confirming }
  return { key: confirming ? latest.operation === 'remove' ? 'confirmingDisconnect' : 'confirmingAuthorization' : latest.operation === 'remove' ? 'disconnectionFailed' : 'authorizationFailed',confirming }
}

export const connectionNeedsConfirmation = (operation: ConnectionMetadataSnapshot['application'][number]) =>
  operation.status === 'pending' || operation.errorCode === 'CONNECTION_OUTCOME_UNKNOWN'
