import type { ChatChannel, ChatChannelKind, ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'

export type AssistantConnectedApp = { id: string; name: string; description: string; integration?: IntegrationMetadata; chatKind?: ChatChannelKind; channel?: ChatChannel }
export function chatKindForApp(id: string): ChatChannelKind | undefined {
  // The enum also names future providers; it is not a capability registry.
  return id === 'wechat' ? 'wechat' : undefined
}

/** One product, even when it has both a data authorization and a chat connection. */
export function assistantConnectedApps(items: readonly IntegrationMetadata[], chats: ChatChannelList | null, chatName: (kind: ChatChannelKind) => string, chatDescription: string): AssistantConnectedApp[] {
  const apps = new Map(items.map(integration => [integration.id, { id: integration.id, name: integration.name, description: integration.description ?? '', integration, chatKind: chatKindForApp(integration.id) } as AssistantConnectedApp]))
  const kinds = new Set<ChatChannelKind>(['wechat', ...(chats?.kinds ?? []).filter(chatKindForApp), ...(chats?.channels.map(channel => channel.kind) ?? []).filter(chatKindForApp)])
  for (const kind of kinds) if (!apps.has(kind)) apps.set(kind, { id: kind, name: chatName(kind), description: chatDescription, chatKind: kind })
  for (const channel of chats?.channels ?? []) { const app = apps.get(channel.kind); if (app && chatKindForApp(channel.kind)) app.channel = channel }
  return [...apps.values()]
}

export const chatAppConnected = (app: AssistantConnectedApp) => app.channel?.health.state === 'running'

export function assistantApplicationCounts(items: readonly IntegrationMetadata[], configured: Record<string, boolean | undefined>, statuses: Record<string, { connected: boolean } | undefined> | null | undefined, chats: ChatChannelList | null) {
  const apps = assistantConnectedApps(items, chats, kind => kind, '')
  return {
    connected: apps.filter(app => chatAppConnected(app) || statuses?.[app.id]?.connected).length,
    saved: apps.filter(app => configured[app.id] || app.channel).length,
  }
}
