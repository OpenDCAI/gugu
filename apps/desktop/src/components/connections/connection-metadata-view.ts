import type { ConnectionStatus } from '@/session/shared/issue-providers'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { assistantAccountDisplayName } from '../assistant/assistant-app-connections'
import type { ConnectionMetadataItem, ConnectionMetadataSnapshot } from './connection-metadata'

/** Saved does not mean verified. Pending operations suppress old health observations. */
export function connectionMetadataView(items: IntegrationMetadata[], rows: ConnectionMetadataItem[], snapshot: ConnectionMetadataSnapshot) {
  const accounts = rows.filter(row => !row.deleted_at && !row.resource_key.startsWith('catalog:') && !row.resource_key.startsWith('__collection__'))
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
    const metadata = primary?.data.publicMetadata as Record<string, unknown> | undefined
    const accountName = assistantAccountDisplayName(metadata?.displayName) ?? assistantAccountDisplayName(metadata?.login)
      ?? assistantAccountDisplayName(primary?.data.displayName)
    const result = primary && accountChecks.has(primary.resource_key) ? primary.data.checkResult : undefined
    if (result === 'ok' || result === 'connected' || result === 'reauth' || result === 'failed') statuses[item.id] = {
      connected: result === 'ok' || result === 'connected',capabilities: item.capabilities,
      ...(result === 'reauth' ? { errorType: 'authorization_expired' as const } : {}),
      ...(accountName ? { displayName: accountName } : {}),
    }
  }
  return { items,configured,statuses,accounts,accountChecks }
}
