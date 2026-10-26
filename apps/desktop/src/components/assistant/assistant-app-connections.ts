import type { ChatChannelKind, ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectorState } from '@/session/renderer/features/assistant/assistant-connector-status'

export type ApplicationConnectionState = ConnectorState | 'paused' | 'retrying'
export type AssistantConnectedApp = { id: string; name: string; description: string; integration?: IntegrationMetadata; state: ApplicationConnectionState; saved: boolean }

/** Legacy snapshots used the internal default credential key as an account name. */
export function assistantAccountDisplayName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name !== 'default' ? name : null
}

/** Normalize each provider's real connection state before displaying, counting or sorting apps. */
export function assistantConnectedApps(items: readonly IntegrationMetadata[], services: ChatChannelList | null,
  applicationName: (id: ChatChannelKind) => string, wechatDescription: string,
  stateFor: (id: string) => ConnectorState = () => 'notConnected', configured: Record<string, boolean | undefined> = {}): AssistantConnectedApp[] {
  const apps = new Map(items.map(integration => [integration.id, { id: integration.id, name: integration.name,
    description: integration.description ?? '', integration, state: stateFor(integration.id), saved: !!configured[integration.id] } as AssistantConnectedApp]))
  const connection = services?.channels.find(item => item.kind === 'wechat')
  const health = connection?.health.state
  apps.set('wechat', { id: 'wechat', name: applicationName('wechat'), description: wechatDescription,
    saved: !!connection, state: health === 'running' ? 'connected' : health === 'starting' ? 'checking'
      : health === 'paused' ? 'paused' : health === 'retrying' ? 'retrying' : connection ? 'checkFailed' : 'notConnected' })
  return [...apps.values()]
}

export function assistantApplicationCounts(items: readonly IntegrationMetadata[], configured: Record<string, boolean | undefined>,
  statuses: Record<string, { connected: boolean } | undefined> | null | undefined, services: ChatChannelList | null) {
  const apps = assistantConnectedApps(items, services, id => id, '', id => statuses?.[id]?.connected ? 'connected' : 'unverified', configured)
  return { connected: apps.filter(app => app.state === 'connected').length, saved: apps.filter(app => app.saved).length }
}
