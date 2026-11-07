import { useQuery } from '@tanstack/react-query'
import { useLocale } from '@/i18n'
import { connectionMetadataKey, type ConnectionMetadataStore } from '../connections/connection-metadata'
import { isAssistantPanelReadRetryable,retryAssistantPanelRead,withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { peekAssistantPanelIntegration,readAssistantPanelIntegration } from './assistant-panel-integrations'

export function useAssistantPanelIntegration(panel: ConnectionMetadataStore | undefined,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const query = useQuery({ queryKey: ['assistant',panel?.ownerId,panel ? connectionMetadataKey(panel) : null,'integration-detail',summary?.id,summary?.catalogVersion,resolvedLocale],
    queryFn: () => withAssistantPanelReadDeadline(() => readAssistantPanelIntegration(panel!,summary!.id,resolvedLocale,summary?.catalogVersion)),
    initialData: () => peekAssistantPanelIntegration(panel,summary?.id,resolvedLocale),
    placeholderData: (previous, query) => query?.queryKey[1] === panel?.ownerId && query?.queryKey[2] === (panel ? connectionMetadataKey(panel) : null) ? previous : undefined,
    enabled: !!panel && summary?.metadataOnly === true,staleTime: summary?.catalogVersion ? Infinity : 0,retry: retryAssistantPanelRead,
    refetchOnWindowFocus: q => isAssistantPanelReadRetryable(q.state.error),
    refetchInterval: q => q.state.error && isAssistantPanelReadRetryable(q.state.error) ? 30_000 : false,
  })
  return { data: summary?.metadataOnly ? query.data : summary,error: summary?.metadataOnly ? query.error : null,
    loading: summary?.metadataOnly === true && query.isLoading }
}
