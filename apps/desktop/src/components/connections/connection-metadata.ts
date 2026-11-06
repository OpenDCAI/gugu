import type { ConnectionApplication } from '@gugu/core/cloud/connections'
import type { AssistantPanelItem, AssistantPanelReceipt, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'

/** Public integration metadata shared by the owner service and legacy panel
 * readers. An assistant identity is never required by a connection consumer. */
export type ConnectionMetadataItem = Omit<AssistantPanelItem, 'assistant_user_id'> & {
  source?: { scopeKey: string; resourceKey: string }
}
export type ConnectionMetadataSnapshot = Omit<AssistantPanelSnapshot, 'items' | 'application'> & {
  items: ConnectionMetadataItem[]
  application: (AssistantPanelSnapshot['application'][number] & Partial<Omit<ConnectionApplication,'status' | 'resourceKey'>> & { wireStatus?: ConnectionApplication['status'] })[]
}

export interface ConnectionMetadataStore {
  ownerId: string
  deviceId?: string
  authorityEpoch?: string
  /** Legacy readers keep their own cache namespace while they still exist. */
  assistantId?: string
  snapshot(): Promise<ConnectionMetadataSnapshot>
  peekSnapshot?(): ConnectionMetadataSnapshot | undefined
  collection(domain: 'integrations'): Promise<ConnectionMetadataItem[]>
  body(item: ConnectionMetadataItem): Promise<Uint8Array>
  peekBody?(item: ConnectionMetadataItem): Uint8Array | undefined
  assertCurrent(): void | Promise<void>
  invalidate(): void
  change(item: ConnectionMetadataItem, operation: 'remove' | 'enable' | 'disable'): Promise<AssistantPanelReceipt>
  save(item: ConnectionMetadataItem, data: Record<string, unknown>): Promise<AssistantPanelReceipt>
}

export const connectionMetadataKey = (store: ConnectionMetadataStore) =>
  JSON.stringify(store.assistantId ? [store.ownerId,store.assistantId,store.deviceId ?? null,...(store.authorityEpoch ? [store.authorityEpoch] : [])]
    : [store.ownerId,'owner-connections',store.authorityEpoch ?? null,store.deviceId ?? null])

export function connectionMetadataCollection(snapshot: ConnectionMetadataSnapshot, deviceId?: string) {
  return snapshot.items.filter(row => row.domain === 'integrations' && !row.deleted_at
    && row.resource_key !== '__collection__' && !row.resource_key.startsWith('__collection__:')
    && (!deviceId || row.device_id === deviceId))
}
