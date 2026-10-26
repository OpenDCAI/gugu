import { expect, it } from 'vitest'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { assistantConnectedApps, chatAppConnected, assistantApplicationCounts } from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'

it('shows only implemented connection types instead of treating provider enum values as capabilities', () => {
  const integrations = [{ id: 'feishu', name: '飞书', description: '文档' }, { id: 'dingtalk', name: '钉钉' }] as IntegrationMetadata[]
  const chats = { kinds: ['wechat'], channels: [] } as ChatChannelList
  const apps = assistantConnectedApps(integrations, chats, kind => kind, '聊天')
  expect(apps.map(app => app.id)).toEqual(['feishu', 'dingtalk', 'wechat'])
  expect(apps[0]!.chatKind).toBeUndefined()
  expect(apps[1]!.chatKind).toBeUndefined()
  expect(apps[2]).toMatchObject({ chatKind: 'wechat' })
  expect(apps[2]!.integration).toBeUndefined()
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

it('counts one product once across data and chat, without treating unverified grants as connected', () => {
  const items = [{ id: 'feishu', name: '飞书' }] as IntegrationMetadata[]
  const chats = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state: 'running' } }] } as ChatChannelList
  expect(assistantApplicationCounts(items, { feishu: true }, { feishu: { connected: true } }, chats)).toEqual({ connected: 2, saved: 2 })
  expect(assistantApplicationCounts(items, { feishu: true }, undefined, null)).toEqual({ connected: 0, saved: 1 })
})
