import { useCallback,useEffect,useSyncExternalStore } from 'react'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { enrichAssistantPanelIntegrations } from './assistant-panel-integrations'

export const EMPTY_INTEGRATION_SUMMARIES: IntegrationMetadata[] = []
type Summary = Pick<IntegrationMetadata,'name' | 'description'>
type SummaryCache = { summaries: Map<string,Summary>; pending: Set<string>; revision: number; listeners: Set<() => void> }
const caches = new Map<string,SummaryCache>()
function summaryCache(panel: AssistantPanelFiles | undefined,locale: string): SummaryCache {
  const key = JSON.stringify([panel?.ownerId,panel?.assistantId,locale])
  let cache = caches.get(key)
  if (!cache) { cache = { summaries: new Map(),pending: new Set(),revision: 0,listeners: new Set() }; caches.set(key,cache) }
  return cache
}
export function useAssistantIntegrationSummaries(panel: AssistantPanelFiles | undefined,items: IntegrationMetadata[],locale: string): IntegrationMetadata[] {
  const cache = summaryCache(panel,locale)
  const subscribe = useCallback((listener: () => void) => { cache.listeners.add(listener); return () => { cache.listeners.delete(listener) } },[cache])
  const snapshot = useCallback(() => cache.revision,[cache])
  useSyncExternalStore(subscribe,snapshot,snapshot)
  useEffect(() => {
    if (!panel) return
    const missing = items.filter(item => item.metadataOnly && (!item.description || item.name === item.id) && !cache.summaries.has(item.id) && !cache.pending.has(item.id))
    if (!missing.length) return
    for (const item of missing) cache.pending.add(item.id)
    // List refreshes and remounts share this bounded enrichment, rather than
    // clearing useful text or starting another body download.
    void enrichAssistantPanelIntegrations(panel,missing,locale,(id,summary) => {
      cache.summaries.set(id,summary); cache.revision++
      for (const listener of cache.listeners) listener()
    }).finally(() => { for (const item of missing) cache.pending.delete(item.id) })
  },[panel,items,locale,cache])
  return items.map(item => {
    const summary = cache.summaries.get(item.id)
    return !summary || !item.metadataOnly ? item : { ...item,
      name: item.name === item.id ? summary.name : item.name,description: item.description || summary.description,
    }
  })
}
