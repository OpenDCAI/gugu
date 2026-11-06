import { ConnectionError, parseConnectionSnapshot, type ConnectionClient, type ConnectionSnapshot } from '@gugu/core/cloud/connections'
import type { ConnectionMetadataItem, ConnectionMetadataSnapshot } from './connection-metadata'
import { createConnectionMetadataStore, type ConnectionMetadataCache } from './connection-metadata-store'
import { assertConnectionApplicationAvailable } from './connection-action-guard'

export const ownerConnectionResourceKey = (scopeKey: string, resourceKey: string) => JSON.stringify([scopeKey, resourceKey])

export function isOwnerConnectionMetadataCache(value: unknown, ownerId: string): value is ConnectionMetadataSnapshot {
  try {
    const snapshot = value as ConnectionMetadataSnapshot
    if (snapshot.version !== 1 || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.application)) return false
    const items = snapshot.items.map(item => {
      if (item.owner_user_id !== ownerId || item.domain !== 'integrations' || !item.source || item.body_item_id !== null
        || item.resource_key !== (item.source.resourceKey.startsWith('catalog:') ? item.source.resourceKey : ownerConnectionResourceKey(item.source.scopeKey,item.source.resourceKey)))
        throw new Error('CONNECTION_CACHE_INVALID')
      const { publicMetadata, ...data } = item.data
      return { ...item.source,deviceId: item.device_id,revision: item.revision,data,publicMetadata: publicMetadata ?? null,
        document: null,bodySha256: item.body_sha256,deletedAt: item.deleted_at,staleAt: item.stale_at ?? null,
        observedAt: item.observed_at,updatedAt: item.updated_at }
    })
    const application = snapshot.application.map(change => {
      if (change.domain !== 'integrations') throw new Error('CONNECTION_CACHE_INVALID')
      const [scopeKey,resourceKey] = JSON.parse(change.resourceKey) as [unknown,unknown]
      return { ...change,status: (change as typeof change & { wireStatus?: string }).wireStatus ?? change.status,scopeKey,resourceKey }
    })
    parseConnectionSnapshot({ version: 1,state: 'ready',revision: snapshot.revision,items,application })
    return true
  } catch { return false }
}

/** A renderer projection only. Mutations retain the service's exact scope/key;
 * the encoded display identity keeps equal keys on two devices separate. */
export function connectionMetadataSnapshot(ownerId: string, snapshot: ConnectionSnapshot): ConnectionMetadataSnapshot {
  if (snapshot.state !== 'ready') throw new ConnectionError('not-ready', 'CONNECTION_NOT_READY')
  const catalog = new Map<string, ConnectionMetadataItem>()
  const items: ConnectionMetadataItem[] = []
  for (const item of snapshot.items) {
    const isCatalog = item.resourceKey.startsWith('catalog:')
    const row: ConnectionMetadataItem = {
      owner_user_id: ownerId, domain: 'integrations', resource_key: isCatalog ? item.resourceKey : ownerConnectionResourceKey(item.scopeKey,item.resourceKey),
      source: { scopeKey: item.scopeKey,resourceKey: item.resourceKey }, device_id: item.deviceId, revision: item.revision,
      data: { ...item.data,...(item.publicMetadata ? { publicMetadata: item.publicMetadata } : {}) },
      body_item_id: null, body_sha256: item.bodySha256, deleted_at: item.deletedAt, stale_at: item.staleAt,
      observed_at: item.observedAt, updated_at: item.updatedAt,
    }
    if (isCatalog) {
      const previous = catalog.get(item.resourceKey)
      if (!previous || BigInt(previous.revision) < BigInt(row.revision)) catalog.set(item.resourceKey,row)
    } else items.push(row)
  }
  return { version: 1, revision: snapshot.revision, items: [...catalog.values(),...items], application: snapshot.application.map(change => ({
    ...change, wireStatus: change.status,status: change.status === 'started' ? 'pending' : change.status,domain: 'integrations', resourceKey: ownerConnectionResourceKey(change.scopeKey,change.resourceKey),
  })) }
}

export function createOwnerConnectionStore(input: {
  ownerId: string; deviceId?: string | null; accountId(): string | null; client: ConnectionClient; cache: ConnectionMetadataCache; changed(): void
  executePlatformOperation?(operationId: string): Promise<void>
}) {
  const assertCurrent = () => { if (input.accountId() !== input.ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED') }
  const store = createConnectionMetadataStore({ ownerId: input.ownerId,accountId: input.accountId,cache: input.cache,changed: input.changed,assertCurrent,
    read: async () => connectionMetadataSnapshot(input.ownerId,await input.client.snapshot(input.deviceId ?? null)),
    commit: async change => {
      const source = JSON.parse(change.key) as unknown
      if (!Array.isArray(source) || source.length !== 2 || source.some(value => typeof value !== 'string')) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
      const { publicMetadata: _publicMetadata,...data } = change.data ?? {}
      return input.client.commit({ operationId: change.operationId,scopeKey: source[0],resourceKey: source[1],expectedRevision: change.expectedRevision,
        operation: change.operation,data,deviceId: source[0] === 'platform' ? null : change.deviceId ?? input.deviceId })
    },
    readBody: async item => {
      if (!item.source) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
      const result = await input.client.resource(item.source.scopeKey,item.source.resourceKey)
      assertCurrent()
      if (result.state !== 'ready') throw new ConnectionError('not-ready','CONNECTION_NOT_READY')
      if (!result.item || result.item.deletedAt || result.item.revision !== item.revision) throw new ConnectionError('deleted','CONNECTION_RESOURCE_REMOVED')
      if (result.item.document === null) throw new ConnectionError('body-unavailable','CONNECTION_DOCUMENT_UNAVAILABLE')
      return new TextEncoder().encode(result.item.document)
    },
  })
  function assertAvailable(item: ConnectionMetadataItem) {
    if (item.owner_user_id !== input.ownerId) throw new ConnectionError('42501','CONNECTION_RESOURCE_NOT_OWNED')
    if (!item.source) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
    return assertConnectionApplicationAvailable({ ...input,provider: String(item.data.providerId),scopeKey: item.source.scopeKey,requireReady: true })
  }
  return { ...store,...(input.deviceId ? { deviceId: input.deviceId } : {}),async change(item: ConnectionMetadataItem,operation: Parameters<typeof store.change>[1]) {
    await assertAvailable(item)
    const receipt = await store.change(item,operation)
    try {
      if (item.source?.scopeKey === 'platform' && operation === 'remove' && receipt.status === 'pending') {
        if (!input.executePlatformOperation) throw new ConnectionError('platform-unavailable','CONNECTION_PLATFORM_UNAVAILABLE')
        await input.executePlatformOperation(receipt.operationId)
        assertCurrent()
      }
      return receipt
    } finally { input.changed() }
  },async save(item: ConnectionMetadataItem,data: Record<string,unknown>) {
    await assertAvailable(item)
    return store.save(item,data)
  } }
}
