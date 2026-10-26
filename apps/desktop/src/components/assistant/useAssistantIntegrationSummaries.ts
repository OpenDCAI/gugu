import { useEffect,useMemo,useState } from 'react'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { enrichAssistantPanelIntegrations } from './assistant-panel-integrations'

export const EMPTY_INTEGRATION_SUMMARIES: IntegrationMetadata[] = []
export function useAssistantIntegrationSummaries(panel: AssistantPanelFiles | undefined,items: IntegrationMetadata[],locale: string): IntegrationMetadata[] {
  const [patch,setPatch] = useState<{ source: IntegrationMetadata[]; summaries: Record<string,Pick<IntegrationMetadata,'name' | 'description'>> } | null>(null)
  useEffect(() => {
    if (!panel || !items.some(item => item.metadataOnly && (!item.description || item.name === item.id))) return
    let cancelled = false
    void enrichAssistantPanelIntegrations(panel,items,locale,(id,summary) => {
      setPatch(previous => ({ source: items,summaries: { ...(previous?.source === items ? previous.summaries : {}),[id]: summary } }))
    },() => !cancelled)
    return () => { cancelled = true }
  },[panel,items,locale])
  return useMemo(() => patch?.source === items ? items.map(item => patch.summaries[item.id] === undefined ? item : { ...item,...patch.summaries[item.id]! }) : items,[items,patch])
}
