import { expect, it } from 'vitest'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { assistantConnectedApps, chatAppConnected } from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'

it('merges data and chat connections for one product and keeps chat-only products', () => {
  const integrations = [{ id: 'feishu', name: '飞书', description: '文档' }] as IntegrationMetadata[]
  const chats = { kinds: ['feishu', 'wechat'], channels: [{ kind: 'feishu', health: { state: 'running' } }] } as ChatChannelList
  const apps = assistantConnectedApps(integrations, chats, kind => kind, '聊天')
  expect(apps.map(app => app.id)).toEqual(['feishu', 'wechat'])
  expect(apps[0]).toMatchObject({ integration: integrations[0], chatKind: 'feishu', channel: chats.channels[0] })
  expect(chatAppConnected(apps[0]!)).toBe(true)
  expect(apps[1]!.integration).toBeUndefined()
})

it('does not describe saved, retrying or starting chats as connected', () => {
  for (const state of ['starting', 'retrying', 'paused', 'broken'] as const) {
    const chats = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state } }] } as ChatChannelList
    expect(chatAppConnected(assistantConnectedApps([], chats, kind => kind, '')[0]!)).toBe(false)
  }
})

it('keeps the known chat entry when the service has not been read', () => {
  const apps = assistantConnectedApps([], null, () => '微信', '聊天')
  expect(apps).toMatchObject([{ id: 'wechat', name: '微信', chatKind: 'wechat' }])
  expect(chatAppConnected(apps[0]!)).toBe(false)
})
