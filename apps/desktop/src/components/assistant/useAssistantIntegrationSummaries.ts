import { useEffect,useMemo,useState } from 'react'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { enrichAssistantPanelIntegrations } from './assistant-panel-integrations'

export const EMPTY_INTEGRATION_SUMMARIES: IntegrationMetadata[] = []
export function useAssistantIntegrationSummaries(panel: AssistantPanelFiles | undefined,items: IntegrationMetadata[],locale: string): IntegrationMetadata[] {
  const [patch,setPatch] = useState<{ source: IntegrationMetadata[]; descriptions: Record<string,string> } | null>(null)
  useEffect(() => {
    if (!panel || !items.some(item => item.metadataOnly && !item.description)) return
    let cancelled = false
    void enrichAssistantPanelIntegrations(panel,items,locale,(id,description) => {
      setPatch(previous => ({ source: items,descriptions: { ...(previous?.source === items ? previous.descriptions : {}),[id]: description } }))
    },() => !cancelled)
    return () => { cancelled = true }
  },[panel,items,locale])
  return useMemo(() => patch?.source === items ? items.map(item => patch.descriptions[item.id] === undefined ? item : { ...item,description: patch.descriptions[item.id]! }) : items,[items,patch])
}
