import { expect, it } from 'vitest'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { assistantConnectedApps, assistantApplicationCounts } from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'

it('normalizes actual product connections into one app model', () => {
  const items = [{ id: 'feishu', name: '飞书', description: '文档' }, { id: 'dingtalk', name: '钉钉' }] as IntegrationMetadata[]
  const apps = assistantConnectedApps(items, { kinds: ['wechat'], channels: [], suggestedAgentId: null }, () => '微信', '在微信里和咕咕聊天')
  expect(apps.map(app => app.id)).toEqual(['feishu', 'dingtalk', 'wechat'])
  expect(apps[2]).toMatchObject({ name: '微信', state: 'notConnected', saved: false })
  expect(apps.every(app => !('chatKind' in app) && !('channel' in app))).toBe(true)
})

it('does not count starting, retrying, paused or broken connections as connected', () => {
  for (const state of ['starting', 'retrying', 'paused', 'broken'] as const) {
    const services = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state } }] } as ChatChannelList
    const apps = assistantConnectedApps([], services, id => id, '')
    expect(apps[0]!.state).not.toBe('connected')
    expect(apps[0]!.saved).toBe(true)
  }
})

it('retains the known WeChat entry while its account state is unavailable', () => {
  expect(assistantConnectedApps([], null, () => '微信', '聊天')).toMatchObject([{ id: 'wechat', name: '微信', state: 'notConnected' }])
})

it('counts connected products once, without treating saved unverified grants as connected', () => {
  const items = [{ id: 'feishu', name: '飞书' }] as IntegrationMetadata[]
  const services = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state: 'running' } }] } as ChatChannelList
  expect(assistantApplicationCounts(items, { feishu: true }, { feishu: { connected: true } }, services)).toEqual({ connected: 2, saved: 2 })
  expect(assistantApplicationCounts(items, { feishu: true }, undefined, null)).toEqual({ connected: 0, saved: 1 })
})
