import { createConnectionClient, ConnectionError } from '@gugu/core/cloud/connections'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { identityDb } from '@/lib/supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '@/lib/realtimeChannel'
import type { ConnectionBridge, ConnectionWindow } from '@/lib/connectionBridge'
import { assistantPanelCacheStore } from '../assistant/assistant-panel-cache'
import { createOwnerConnectionStore, isOwnerConnectionMetadataCache } from './owner-connection-store'
import type { ConnectionMetadataSnapshot, ConnectionMetadataStore } from './connection-metadata'
import { CONNECTIONS_CHANGED } from './owner-connection-metadata'
import { rendererPlatformIntegrationsClient } from '@/lib/platformIntegrations'

const accountId = () => getRendererSession()?.user.id ?? null
export const ownerConnectionClient = createConnectionClient(async (name,args) => {
  const { data,error,status } = await identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
  return { data,error,status }
},accountId)
const stores = new Map<string,ConnectionMetadataStore>()
async function executePlatformOperation(operationId: string) {
  const owner = accountId()
  const snapshot = await ownerConnectionClient.snapshot()
  if (snapshot.state !== 'ready') throw new ConnectionError('not-ready','CONNECTION_NOT_READY')
  const operation = snapshot.application.find(change => change.operationId === operationId)
  // The refreshed head no longer has an outstanding operation: its receipt is settled.
  if (!operation) return
  if (operation.scopeKey !== 'platform' || operation.operation !== 'remove' || operation.terminal)
    throw new ConnectionError('operation-refused','CONNECTION_OPERATION_UNSUPPORTED')
  const item = snapshot.items.find(row => row.scopeKey === 'platform' && row.resourceKey === operation.resourceKey)
  if (typeof item?.data.providerId !== 'string') throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
  const result = await rendererPlatformIntegrationsClient().disconnectOperation!(item.data.providerId,operationId,snapshot.revision)
  if (accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
  if (result.resourceKey !== operation.resourceKey) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_MISMATCH')
  if (result.status === 'failed') throw new ConnectionError(result.errorCode ?? 'platform-unavailable','CONNECTION_PLATFORM_REVOKE_FAILED')
}
const bridge: ConnectionBridge = {
  accountId,
  subscribeAccount: listener => observeRendererSession(() => listener()),
  client: ownerConnectionClient,
  metadata(ownerId,deviceId = null) {
    if (accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    const key = JSON.stringify([ownerId,deviceId])
    let store = stores.get(key)
    if (!store) {
      const cache = assistantPanelCacheStore().accountState<ConnectionMetadataSnapshot>(ownerId,`owner-connections.v1:${deviceId ?? 'all'}`,
        (value): value is ConnectionMetadataSnapshot => isOwnerConnectionMetadataCache(value,ownerId))
      store = createOwnerConnectionStore({ ownerId,deviceId,accountId,client: ownerConnectionClient,cache,
        executePlatformOperation,
        changed: () => window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED,{ detail: { ownerId } })),
      })
      stores.set(key,store)
    }
    return store
  },
  async retryOperation(operationId) {
    try { await executePlatformOperation(operationId) }
    finally { window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED,{ detail: { ownerId: accountId() } })) }
  },
  subscribeChanges(ownerId,listener) {
    if (accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    // Best-effort owner hint. Reconnect and explicit refresh repair lost hints.
    const handle = subscribePrivateUserEventBus(ownerId,'connection_changed',listener,{ onSubscribed: listener })
    return () => unsubscribePrivateUserEventBus(handle)
  },
}

export function installConnectionHost(w: Window = window) {
  (w as ConnectionWindow).__GUGU_CONNECTIONS__ = bridge
}
