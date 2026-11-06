import { connectionMetadataCollection, type ConnectionMetadataStore } from './connection-metadata'
import { builtinConnectionCatalog } from './builtin-connection-catalog'
import { connectionMetadataView } from './connection-metadata-view'
import { parseAssistantPanelIntegrations } from '../assistant/assistant-panel-integrations'
import type { ConnectionMetadataSnapshot } from './connection-metadata'

export const CONNECTIONS_CHANGED = 'gugu:connections-changed'

export async function readOwnerConnectionMetadata(store: ConnectionMetadataStore, locale: string) {
  const snapshot = await store.snapshot()
  return ownerConnectionMetadataView(snapshot,locale)
}

export function peekOwnerConnectionMetadata(store: ConnectionMetadataStore, locale: string) {
  const snapshot = store.peekSnapshot?.()
  return snapshot ? ownerConnectionMetadataView(snapshot,locale) : undefined
}

export function ownerConnectionMetadataView(snapshot: ConnectionMetadataSnapshot,locale: string) {
  const rows = connectionMetadataCollection(snapshot)
  const published = parseAssistantPanelIntegrations(rows,snapshot,locale).items
  const items = new Map(builtinConnectionCatalog(locale).map(item => [item.id,item]))
  for (const item of published) {
    const builtin = items.get(item.id)
    if (!builtin) items.set(item.id,item)
    else if (item.catalog) items.set(item.id,{ ...builtin,catalog: item.catalog })
  }
  return connectionMetadataView([...items.values()],rows,snapshot)
}
