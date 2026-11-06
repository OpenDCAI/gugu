import { ConnectionError, type ConnectionClient, type ConnectionCommit, type ConnectionReceipt } from '@gugu/core/cloud/connections'

export type ConnectionAuthorizationIntent = Readonly<{
  ownerId: string; providerId: string; accountId: string | null; operationId: string
  scopeKey: string; deviceId: string | null; resourceKey: string | null; expectedRevision: string | null; recreationId: string
}>

/** A ticket is acquired before the original credential service runs. It never
 * substitutes for that service's authorization or stores any credentials. */
export function createConnectionAuthorization(input: { client: ConnectionClient; accountId(): string | null; changed(): void }) {
  const batches = new Map<string,{ body: string; operations: { operationId: string; data: Record<string,unknown>; document: string }[] }>()
  const commits = new Map<string,ConnectionCommit>()
  const current = (owner: string | null) => {
    if (!owner || input.accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
  }
  return {
    async completeBatch(intent: ConnectionAuthorizationIntent, accounts: { data: Record<string,unknown>; publicMetadata: Record<string,unknown> }[]) {
      current(intent.ownerId)
      if (intent.resourceKey !== null || intent.accountId !== null || !accounts.length || accounts.length > 50
        || accounts.some(({ data,publicMetadata }) => data.providerId !== intent.providerId || typeof data.accountId !== 'string'
          || publicMetadata.providerId !== data.providerId || publicMetadata.accountId !== data.accountId)
        || new Set(accounts.map(row => row.data.accountId)).size !== accounts.length)
        throw new ConnectionError('identity-changed','CONNECTION_AUTHORIZATION_ACCOUNT_CHANGED')
      const body = JSON.stringify(accounts)
      let request = batches.get(intent.operationId)
      if (request && request.body !== body) throw new ConnectionError('identity-changed','CONNECTION_OPERATION_REUSED')
      if (!request) {
        request = { body,operations: accounts.map(({ data,publicMetadata }) => ({ operationId: crypto.randomUUID(),
          data: JSON.parse(JSON.stringify(data)),document: JSON.stringify(publicMetadata) })) }
        batches.set(intent.operationId,request)
      }
      try {
        const result = await input.client.commitBatch({ operationId: intent.operationId,recreationId: intent.recreationId,operations: request.operations })
        current(intent.ownerId)
        const ids = new Set(request.operations.map(row => row.operationId))
        if (result.operationId !== intent.operationId || result.receipts.length !== ids.size
          || result.receipts.some(row => !ids.delete(row.operationId) || row.scopeKey !== intent.scopeKey || !row.resourceKey || row.status === 'failed' || row.status === 'superseded'))
          throw new ConnectionError('intent-changed','CONNECTION_AUTHORIZATION_CHANGED')
        return result
      } finally { input.changed() }
    },
    async begin(providerId: string, scopeKey: string, deviceId: string | null, accountId: string | null = null, operationId = crypto.randomUUID()): Promise<ConnectionAuthorizationIntent> {
      const ownerId = input.accountId()
      current(ownerId)
      const snapshot = await input.client.snapshot(deviceId)
      current(ownerId)
      // A first explicit action may initialize a genuinely new owner. The
      // service rejects unprepared legacy/candidate owners; the renderer never
      // manufactures a prepared collection or caches not-ready as empty.
      const matching = accountId === null ? [] : (snapshot.items ?? []).filter(row => row.scopeKey === scopeKey
        && row.data.providerId === providerId && row.data.accountId === accountId)
      if (matching.length > 1) throw new ConnectionError('ambiguous-resource','CONNECTION_RESOURCE_AMBIGUOUS')
      const item = matching[0]
      // An absent known account still uses the service's provider resolver.
      const resourceKey = item?.resourceKey ?? null,expectedRevision = item?.revision ?? null
      const ticket = await input.client.recreateBegin({ operationId,scopeKey,resourceKey,expectedRevision,deviceId,
        providerId: resourceKey === null ? providerId : null,expectedHeadRevision: resourceKey === null ? snapshot.revision : null })
      current(ownerId)
      return Object.freeze({ ownerId: ownerId!,providerId,accountId,operationId,scopeKey,deviceId,resourceKey,expectedRevision,recreationId: ticket.recreationId })
    },
    async complete(intent: ConnectionAuthorizationIntent, data: Record<string,unknown>, publicMetadata: Record<string,unknown>): Promise<ConnectionReceipt> {
      current(intent.ownerId)
      if (data.providerId !== intent.providerId || typeof data.accountId !== 'string' || !data.accountId
        || publicMetadata.providerId !== intent.providerId || publicMetadata.accountId !== data.accountId
        || intent.accountId !== null && intent.accountId !== data.accountId)
        throw new ConnectionError('identity-changed','CONNECTION_AUTHORIZATION_ACCOUNT_CHANGED')
      const change: ConnectionCommit = { operationId: intent.operationId,scopeKey: intent.scopeKey,resourceKey: intent.resourceKey,
        expectedRevision: intent.expectedRevision,operation: 'save',data: JSON.parse(JSON.stringify(data)),document: JSON.stringify(publicMetadata),deviceId: intent.deviceId,recreationId: intent.recreationId }
      const previous = commits.get(intent.operationId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(change)) throw new ConnectionError('identity-changed','CONNECTION_OPERATION_REUSED')
      commits.set(intent.operationId,change)
      try {
        const receipt = await input.client.commit(change)
        current(intent.ownerId)
        if (receipt.operationId !== intent.operationId || receipt.scopeKey !== intent.scopeKey || !receipt.resourceKey
          || intent.resourceKey !== null && receipt.resourceKey !== intent.resourceKey || receipt.status === 'failed' || receipt.status === 'superseded')
          throw new ConnectionError('intent-changed','CONNECTION_AUTHORIZATION_CHANGED')
        return receipt
      } finally { input.changed() }
    },
  }
}
