import { expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({
  connected: new Set(['dingtalk', 'email', 'github']),
  listAccounts: vi.fn(async (provider: string) => data.connected.has(provider) ? [{ accountId: 'default', updatedAt: 1000, isDefault: true }] : []),
  resolveSecret: vi.fn(() => { throw new Error('Must not decrypt credentials') }),
}))
// #921 a credential the platform keeps: asking the platform first brings in what another device connected.
const platform = vi.hoisted(() => ({
  keepsAmap: false,
  refresh: vi.fn(async () => { if (platform.keepsAmap) data.connected.add('amap'); return true }),
  /** The platform lists the account as needing a reconnect, or the provider rejected this device's old key. */
  amapNeedsReconnect: false,
  needsReconnect: vi.fn((provider: string) => provider === 'amap' && platform.amapNeedsReconnect),
}))
vi.mock('@gugu/session-plugins/integrations', () => ({ integrationPluginRegistry: { getAll: () => [
  { metadata: { id: 'dingtalk', name: '钉钉' } }, { metadata: { id: 'feishu', name: '飞书' } }, { metadata: { id: 'email', name: '邮箱' } },
  { metadata: { id: 'github', name: 'GitHub' } }, { metadata: { id: 'wecom', name: '企业微信' } },
  { metadata: { id: 'amap', name: '高德地图' } },
] } }))
// Mail and AMap (the platform's forwarder, #921) hand their tools to sessions; GitHub only links issues and gives an agent nothing to call.
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/session-integrations', () => ({
  integrationGivesSessionTools: (integrationId: string) => ['email', 'amap'].includes(integrationId),
}))
vi.mock('../../../apps/desktop/electron/session/main/core/provider-accounts/provider-account-registry-instance', () => ({ providerAccountRegistry: data }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/platform-credentials-instance', () => ({ platformCredentials: platform }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations', () => ({
  cliMethodOf: (id: string) => ['dingtalk', 'feishu', 'wecom'].includes(id) ? { kind: 'cli' } : null,
  connectedCliSkills: async (configured: (id: string) => Promise<boolean>) => [
    ...await configured('dingtalk') ? [{ extensionId: 'dingtalk', name: 'dws', dir: '/installed/dws/skills/dws' }] : [],
    ...await configured('feishu') ? ['lark-calendar', 'lark-doc'].map(name => ({ extensionId: 'feishu', name, dir: `/installed/lark/skills/${name}` })) : [],
  ],
}))
import { configuredIntegrationIndex } from '../../../apps/desktop/electron/session/main/core/integrations/integration-resource-index'

it('tells the assistant to delegate a connected CLI application, naming the skills its task should use, without resolving secrets', async () => {
  expect(await configuredIntegrationIndex()).toEqual([
    { id: 'dingtalk:default', name: '钉钉', modifiedAt: '1970-01-01T00:00:01.000Z', isDefault: true,
      use: { note: '钉钉已连接，要用就派任务', delegate: { tool: 'session_spawn' }, task_skills: ['dws'] } },
    { id: 'email:default', name: '邮箱', modifiedAt: '1970-01-01T00:00:01.000Z', isDefault: true,
      use: { note: '邮箱已连接，要用就派任务；任务会话里自带它的工具', delegate: { tool: 'session_spawn' }, task_skills: [] } },
    { id: 'github:default', name: 'GitHub', modifiedAt: '1970-01-01T00:00:01.000Z', isDefault: true, note: '只用来关联 issue，助理不能直接用' },
  ])
  expect(data.resolveSecret).not.toHaveBeenCalled()
})

it('says a connection that hands an agent no tools and no task skills is only for linking issues', async () => {
  const rows = await configuredIntegrationIndex()
  expect(rows.find(row => row.id === 'github:default')).toMatchObject({ note: '只用来关联 issue，助理不能直接用' })
  // Tool and CLI connections keep their own route; they never read as issue-only.
  for (const id of ['email:default', 'dingtalk:default']) expect(rows.find(row => row.id === id)).not.toHaveProperty('note')
})

it('derives the delegation row from the live connection: it appears on connect and disappears on disconnect', async () => {
  data.connected.add('feishu')
  expect((await configuredIntegrationIndex()).find(row => row.id === 'feishu:default')).toMatchObject({
    name: '飞书', use: { note: '飞书已连接，要用就派任务', delegate: { tool: 'session_spawn' }, task_skills: ['lark-calendar', 'lark-doc'] },
  })
  data.connected.delete('feishu')
  expect((await configuredIntegrationIndex()).some(row => row.id.startsWith('feishu:'))).toBe(false)
})

it('never marks a connected CLI application issue-only while its skills cannot be read', async () => {
  data.connected.add('wecom')
  expect((await configuredIntegrationIndex()).find(row => row.id === 'wecom:default')).not.toHaveProperty('note')
  data.connected.delete('wecom')
})

it('lists an integration the platform keeps for the person even when this device never connected it (#921)', async () => {
  expect(data.connected.has('amap')).toBe(false)
  platform.keepsAmap = true // another device connected it
  const rows = await configuredIntegrationIndex()
  expect(platform.refresh).toHaveBeenCalled()
  expect(rows.find(row => row.id === 'amap:default')).toMatchObject({ name: '高德地图', isDefault: true })
  expect(rows.find(row => row.id === 'amap:default')).not.toHaveProperty('note')
})

it('an account that needs a reconnect is not offered as usable: the assistant hears it needs the person on the connection page (#921)', async () => {
  platform.keepsAmap = true
  platform.amapNeedsReconnect = true
  try {
    const row = (await configuredIntegrationIndex()).find(row => row.id === 'amap:default')
    expect(row).toMatchObject({ name: '高德地图', note: '高德地图要重新连接，现在用不了；请他到连接页处理' })
    expect(row).not.toHaveProperty('use')
  } finally {
    platform.amapNeedsReconnect = false
  }
})
