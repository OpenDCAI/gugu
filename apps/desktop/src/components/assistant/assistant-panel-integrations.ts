import { integrationIcons } from '@gugu/session-plugins/integration-icons'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'

/** Catalogs and saved account metadata come from the same complete cloud
 * collection. Reading authorization status never verifies credentials. */
export async function readAssistantPanelIntegrations(panel: AssistantPanelFiles, _locale: string) {
  const rows = await panel.collection('integrations')
  const snapshot = await panel.snapshot()
  const catalog = rows.filter(row => row.resource_key.startsWith('catalog:'))
  const items: IntegrationMetadata[] = catalog.map(row => ({
    id: String(row.data.providerId),name: String(row.data.displayName ?? row.data.providerId),description: typeof row.data.description === 'string' ? row.data.description : '',
    websiteUrl: '',features: [],disconnectCredentialLabel: undefined,
    capabilities: { requiresRepositoryUrl: false,supportsIssueContext: false },auth: { methods: [] },
    icon: integrationIcons[String(row.data.providerId)] ?? { kind: 'svg',variants: [] },abilities: [],playbooks: [],multiAccount: false,metadataOnly: true,
  }))
  const accounts = rows.filter(row => !row.resource_key.startsWith('catalog:'))
  const configured: Record<string, boolean> = {}, statuses: Record<string, ConnectionStatus> = {}
  const accountChecks = new Map<string, boolean>()
  for (const row of accounts) {
    const checkedAt = typeof row.data.checkedAt === 'number' ? row.data.checkedAt : Date.parse(String(row.data.checkedAt ?? ''))
    if (row.observed_at && !row.stale_at && Number.isFinite(checkedAt)
      && !snapshot.application.some(change => change.domain === 'integrations' && change.resourceKey === row.resource_key)
      && ['ok','connected','reauth','failed'].includes(String(row.data.checkResult))) accountChecks.set(row.resource_key,['ok','connected'].includes(String(row.data.checkResult)))
  }
  for (const item of items) {
    const saved = accounts.filter(row => row.data.providerId === item.id && row.data.configured === true)
    configured[item.id] = saved.length > 0
    const primary = saved.find(row => row.data.isDefault === true) ?? saved[0]
    const result = primary && accountChecks.has(primary.resource_key) ? primary.data.checkResult : undefined
    if (result === 'ok' || result === 'connected' || result === 'reauth' || result === 'failed') statuses[item.id] = {
      connected: result === 'ok' || result === 'connected',capabilities: item.capabilities,
      ...(result === 'reauth' ? { errorType: 'authorization_expired' as const } : {}),
      ...(typeof primary?.data.displayName === 'string' ? { displayName: primary.data.displayName } : {}),
    }
  }
  return { items,configured,statuses,accounts,accountChecks }
}

/** Only the selected catalog entry needs its localized setup description. */
export async function readAssistantPanelIntegration(panel: AssistantPanelFiles,id: string,locale: string): Promise<IntegrationMetadata> {
  const row = (await panel.collection('integrations')).find(row => row.resource_key === `catalog:${id}`)
  if (!row) throw new Error('PANEL_INTEGRATION_UNAVAILABLE')
  const data = JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(await panel.body(row)))
  const item = data[locale === 'zh-CN' ? 'zh-CN' : 'en'] as IntegrationMetadata
  if (data.version !== 1 || !item || item.id !== id || typeof item.name !== 'string' || !Array.isArray(item.auth?.methods)) throw new Error('PANEL_INTEGRATION_UNAVAILABLE')
  return item
}

/** Missing row descriptions are optional enrichment. Four workers avoid queuing
 * a whole catalog ahead of the entry the person explicitly opens. */
export async function enrichAssistantPanelIntegrations(panel: AssistantPanelFiles,items: readonly IntegrationMetadata[],locale: string,
  updated: (id: string,description: string) => void,active: () => boolean = () => true): Promise<void> {
  const missing = items.filter(item => item.metadataOnly && !item.description)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4,missing.length) },async () => {
    while (active() && next < missing.length) {
      const item = missing[next++]!
      try {
        const detail = await readAssistantPanelIntegration(panel,item.id,locale)
        if (active()) updated(item.id,detail.description ?? '')
      } catch { /* A missing description never hides its row or asks for a retry. */ }
    }
  }))
}
