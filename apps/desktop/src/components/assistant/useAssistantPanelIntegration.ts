import { useQuery } from '@tanstack/react-query'
import { useLocale } from '@/i18n'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { isAssistantPanelReadRetryable,retryAssistantPanelRead,withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { readAssistantPanelIntegration } from './assistant-panel-integrations'

export function useAssistantPanelIntegration(panel: AssistantPanelFiles | undefined,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const query = useQuery({ queryKey: ['assistant',panel?.ownerId,panel?.assistantId,'integration-detail',summary?.id,resolvedLocale],
    queryFn: () => withAssistantPanelReadDeadline(() => readAssistantPanelIntegration(panel!,summary!.id,resolvedLocale)),
    enabled: !!panel && summary?.metadataOnly === true,retry: retryAssistantPanelRead,
    refetchOnWindowFocus: q => isAssistantPanelReadRetryable(q.state.error),
    refetchInterval: q => q.state.error && isAssistantPanelReadRetryable(q.state.error) ? 30_000 : false,
  })
  return { data: summary?.metadataOnly ? query.data : summary,error: summary?.metadataOnly ? query.error : null,
    loading: summary?.metadataOnly === true && query.isLoading }
}
