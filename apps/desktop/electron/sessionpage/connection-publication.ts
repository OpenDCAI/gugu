import { createHash, randomUUID } from 'node:crypto'
import { ConnectionError, type ConnectionClient, type ConnectionSnapshot } from '@gugu/core/cloud/connections'

export type ConnectionObservation = { scopeKey: string; resourceKey?: string; deviceId: string | null; data: Record<string,unknown>; document: string }

/** Observations update public metadata only. Absence is never a revocation,
 * and a tombstone is never cleared by a refresh or a delayed publication. */
export async function publishConnectionObservations(input: {
  snapshot: ConnectionSnapshot; observations: readonly ConnectionObservation[]; client: ConnectionClient; runtimeInstanceId: string
}) {
  if (input.snapshot.state !== 'ready') return
  for (const observed of input.observations) {
    const matching = input.snapshot.items.filter(item => item.scopeKey === observed.scopeKey && (observed.resourceKey
      ? item.resourceKey === observed.resourceKey : item.data.providerId === observed.data.providerId && item.data.accountId === observed.data.accountId))
    if (matching.length > 1) throw new ConnectionError('ambiguous-resource','CONNECTION_RESOURCE_AMBIGUOUS')
    const previous = matching[0]
    if (previous?.deletedAt) continue
    const hash = createHash('sha256').update(observed.document,'utf8').digest('hex')
    if (previous && previous.bodySha256 === hash && sameData(previous.data,observed.data)) continue
    // Imported identities always retain the service-returned key. This format
    // is used only for a first observation with expectedRevision=0.
    const resourceKey = previous?.resourceKey ?? observed.resourceKey ?? JSON.stringify([observed.data.providerId,observed.data.accountId])
    await input.client.commit({ operationId: randomUUID(),scopeKey: observed.scopeKey,resourceKey,expectedRevision: previous?.revision ?? '0',
      operation: 'save',data: observed.data,document: observed.document,deviceId: observed.deviceId,runtimeInstanceId: input.runtimeInstanceId })
  }
}
const sameData = (a: Record<string,unknown>,b: Record<string,unknown>) => JSON.stringify(Object.entries(a).sort(([x],[y]) => x.localeCompare(y)))
  === JSON.stringify(Object.entries(b).sort(([x],[y]) => x.localeCompare(y)))
