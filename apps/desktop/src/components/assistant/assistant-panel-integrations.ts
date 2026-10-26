import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'

/** Catalogs and saved account metadata come from the same complete cloud
 * collection. Reading authorization status never verifies credentials. */
export async function readAssistantPanelIntegrations(panel: AssistantPanelFiles, locale: string) {
  const rows = await panel.collection('integrations')
  const catalog = rows.filter(row => row.resource_key.startsWith('catalog:'))
  const items = await Promise.all(catalog.map(async row => {
    const data = JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(await panel.body(row)))
    const item = data[locale === 'zh-CN' ? 'zh-CN' : 'en'] as IntegrationMetadata
    if (data.version !== 1 || !item || item.id !== row.data.providerId || typeof item.name !== 'string' || !Array.isArray(item.auth?.methods)) throw new Error('Integration catalog could not be read')
    return item
  }))
  const accounts = rows.filter(row => !row.resource_key.startsWith('catalog:'))
  const configured: Record<string, boolean> = {}, statuses: Record<string, ConnectionStatus> = {}
  for (const item of items) {
    const saved = accounts.filter(row => row.data.providerId === item.id && row.data.configured === true)
    configured[item.id] = saved.length > 0
    const primary = saved.find(row => row.data.isDefault === true) ?? saved[0]
    const result = primary?.data.checkResult
    if (result === 'ok' || result === 'connected' || result === 'reauth' || result === 'failed') statuses[item.id] = {
      connected: result === 'ok' || result === 'connected',capabilities: item.capabilities,
      ...(typeof primary?.data.displayName === 'string' ? { displayName: primary.data.displayName } : {}),
    }
  }
  return { items,configured,statuses,accounts }
}
