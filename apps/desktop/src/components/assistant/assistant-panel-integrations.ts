import { integrationIcons } from '@gugu/session-plugins/integration-icons'
import { builtinIntegrationSummary } from '@gugu/session-plugins/integration-summaries'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { assistantPanelCollection,type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'

/** Catalogs and saved account metadata come from the same complete cloud
 * collection. Reading authorization status never verifies credentials. */
export function integrationListCopy(id: string,name: unknown,description: unknown,locale: string) {
  const builtin = builtinIntegrationSummary(id,locale)
  if (builtin) return { ...builtin,summaryNameMissing: false }
  const summaryNameMissing = typeof name !== 'string' || !name.trim() || name.trim() === id
  return { name: summaryNameMissing ? locale === 'zh-CN' ? '应用' : 'Application' : name.trim(),
    description: typeof description === 'string' ? description : '',summaryNameMissing }
}
export async function readAssistantPanelIntegrations(panel: AssistantPanelFiles, locale: string) {
  const rows = await panel.collection('integrations')
  const snapshot = await panel.snapshot()
  return parseAssistantPanelIntegrations(rows,snapshot,locale)
}
type Snapshot = Awaited<ReturnType<AssistantPanelFiles['snapshot']>>
function parseAssistantPanelIntegrations(rows: AssistantPanelItem[],snapshot: Snapshot,locale: string) {
  const catalog = rows.filter(row => row.resource_key.startsWith('catalog:'))
  const items: IntegrationMetadata[] = catalog.map(row => ({
    id: String(row.data.providerId),catalogVersion: row.body_sha256 ?? row.revision,...integrationListCopy(String(row.data.providerId),row.data.displayName,row.data.description,locale),
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

/** The same parser backs first-frame local content and background cloud verification. */
export function peekAssistantPanelIntegrations(panel: AssistantPanelFiles | undefined,locale: string) {
  const snapshot = panel?.peekSnapshot?.()
  if (!snapshot) return undefined
  const collection = assistantPanelCollection(snapshot,'integrations',panel?.deviceId)
  if (collection.state !== 'ready' && !collection.items.some(row => row.resource_key.startsWith('catalog:'))) return undefined
  return parseAssistantPanelIntegrations(collection.items,snapshot,locale)
}
function parseIntegrationBody(row: AssistantPanelItem,id: string,locale: string,bytes: Uint8Array): IntegrationMetadata {
  const data = JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes))
  const item = data[locale === 'zh-CN' ? 'zh-CN' : 'en'] as IntegrationMetadata
  if (data.version !== 1 || !item || item.id !== id || typeof item.name !== 'string' || item.description !== undefined && typeof item.description !== 'string' || !Array.isArray(item.auth?.methods)) throw new Error('PANEL_INTEGRATION_UNAVAILABLE')
  return { ...item,...integrationListCopy(id,item.name === id ? row.data.displayName : item.name,item.description,locale),icon: integrationIcons[id] ?? item.icon }
}
export function peekAssistantPanelIntegration(panel: AssistantPanelFiles | undefined,id: string | undefined,locale: string) {
  if (!panel || !id) return undefined
  const snapshot = panel.peekSnapshot?.()
  if (!snapshot) return undefined
  const row = assistantPanelCollection(snapshot,'integrations',panel.deviceId).items.find(row => row.resource_key === `catalog:${id}`)
  if (!row) return undefined
  const bytes = panel.peekBody?.(row)
  if (!bytes) return undefined
  try { return parseIntegrationBody(row,id,locale,bytes) } catch { return undefined }
}

type DetailEntry = { version: string | undefined; promise: Promise<IntegrationMetadata>; value?: IntegrationMetadata }
const integrationDetails = new WeakMap<AssistantPanelFiles, Map<string, DetailEntry>>()
export function cachedAssistantPanelIntegration(panel: AssistantPanelFiles | undefined,id: string | undefined,locale: string,version: string | undefined) {
  if (!panel || !id || !version) return undefined
  const entry = integrationDetails.get(panel)?.get(`${id}|${locale}`)
  return entry?.version === version ? entry.value : undefined
}

/** Content versions share an in-flight read and a parsed result; account state is never cached here. */
export async function readAssistantPanelIntegration(panel: AssistantPanelFiles,id: string,locale: string,version?: string): Promise<IntegrationMetadata> {
  const key = `${id}|${locale}`
  const entries = integrationDetails.get(panel) ?? new Map<string, DetailEntry>()
  integrationDetails.set(panel,entries)
  const previous = entries.get(key)
  if (version && previous?.version === version) return previous.promise
  const row = (await panel.collection('integrations')).find(row => row.resource_key === `catalog:${id}`)
  if (!row) throw new Error('PANEL_INTEGRATION_UNAVAILABLE')
  const actualVersion = row.body_sha256 ?? row.revision
  const current = entries.get(key)
  if (actualVersion && current?.version === actualVersion) return current.promise
  const entry: DetailEntry = { version: actualVersion, promise: Promise.resolve().then(async () => {
    return parseIntegrationBody(row,id,locale,await panel.body(row))
  }) }
  entries.set(key,entry)
  try { entry.value = await entry.promise; return entry.value }
  catch (error) { if (entries.get(key) === entry) entries.delete(key); throw error }
}

/** Missing names and descriptions are optional enrichment. Four workers avoid queuing
 * a whole catalog ahead of the entry the person explicitly opens. */
export async function enrichAssistantPanelIntegrations(panel: AssistantPanelFiles,items: readonly IntegrationMetadata[],locale: string,
  updated: (id: string,summary: Pick<IntegrationMetadata,'name' | 'description'>) => void,active: () => boolean = () => true): Promise<void> {
  const missing = items.filter(item => item.metadataOnly && !builtinIntegrationSummary(item.id,locale) && (!item.description || item.name === item.id || item.summaryNameMissing))
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4,missing.length) },async () => {
    while (active() && next < missing.length) {
      const item = missing[next++]!
      try {
        const detail = await readAssistantPanelIntegration(panel,item.id,locale,item.catalogVersion)
        if (active()) updated(item.id,{ name: detail.name,description: detail.description || item.description || '' })
      } catch { /* A missing description never hides its row or asks for a retry. */ }
    }
  }))
}
