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
import { createConnectionRouting,connectionClientForRoute,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

const accountId = () => getRendererSession()?.user.id ?? null
export const ownerConnectionClient = createConnectionClient(async (name,args) => {
  const { data,error,status } = await identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
  return { data,error,status }
},accountId)
const stores = new Map<string,ConnectionMetadataStore>()
const routing = createConnectionRouting({ accountId,read: () => ownerConnectionClient.authority(),
  changed: ownerId => window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED,{ detail: { ownerId } })) })
async function executePlatformOperation(operationId: string,route: ConnectionRoute) {
  await routing.assert(route,true)
  const owner = accountId()
  const snapshot = await connectionClientForRoute(ownerConnectionClient,routing,route).snapshot()
  if (snapshot.state !== 'ready') throw new ConnectionError('not-ready','CONNECTION_NOT_READY')
  const operation = snapshot.application.find(change => change.operationId === operationId)
  // No longer outstanding: stop executing without inferring an outcome from absence.
  if (!operation) return
  if (operation.scopeKey !== 'platform' || operation.operation !== 'remove' || operation.terminal)
    throw new ConnectionError('operation-refused','CONNECTION_OPERATION_UNSUPPORTED')
  const item = snapshot.items.find(row => row.scopeKey === 'platform' && row.resourceKey === operation.resourceKey)
  if (typeof item?.data.providerId !== 'string') throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
  await routing.assert(route,true)
  const result = await rendererPlatformIntegrationsClient().disconnectOperation!(item.data.providerId,operationId,snapshot.revision)
  if (accountId() !== owner) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
  await routing.assert(route)
  if (result.resourceKey !== operation.resourceKey) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_MISMATCH')
  if (result.status === 'failed') throw new ConnectionError(result.errorCode ?? 'platform-unavailable','CONNECTION_PLATFORM_REVOKE_FAILED')
}
const bridge: ConnectionBridge = {
  accountId,
  subscribeAccount: listener => observeRendererSession(() => listener()),
  client: ownerConnectionClient,
  routing,
  metadata(ownerId,deviceId = null,route = routing.peek()) {
    if (accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    if (route?.mode !== 'owner') throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
    const key = JSON.stringify([ownerId,route.mode,route.epoch,deviceId])
    let store = stores.get(key)
    if (!store) {
      const cache = assistantPanelCacheStore().accountState<ConnectionMetadataSnapshot>(ownerId,`owner-connections.v1:${route.epoch}:${deviceId ?? 'all'}`,
        (value): value is ConnectionMetadataSnapshot => isOwnerConnectionMetadataCache(value,ownerId))
      store = createOwnerConnectionStore({ ownerId,deviceId,accountId,client: connectionClientForRoute(ownerConnectionClient,routing,route),cache,
        executePlatformOperation: id => executePlatformOperation(id,route),
        changed: () => window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED,{ detail: { ownerId } })),
      })
      store = { ...store,authorityEpoch: route.epoch,assertCurrent: async () => {
        if (accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
        await routing.assert(route)
      } }
      stores.set(key,store)
    }
    return store
  },
  async retryOperation(operationId) {
    const route = await routing.capture()
    if (route.mode !== 'owner') throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
    try { await executePlatformOperation(operationId,route) }
    finally { window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED,{ detail: { ownerId: accountId() } })) }
  },
  subscribeChanges(ownerId,listener) {
    if (accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    // Best-effort owner hint. Reconnect and explicit refresh repair lost hints.
    const handle = subscribePrivateUserEventBus(ownerId,'connection_changed',listener,{ onSubscribed: listener })
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.ownerId === ownerId) listener() }
    window.addEventListener(CONNECTIONS_CHANGED,changed)
    return () => { window.removeEventListener(CONNECTIONS_CHANGED,changed); unsubscribePrivateUserEventBus(handle) }
  },
}

export function installConnectionHost(w: Window = window) {
  (w as ConnectionWindow).__GUGU_CONNECTIONS__ = bridge
}
