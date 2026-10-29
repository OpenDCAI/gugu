import { expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({
  connected: new Set(['dingtalk', 'email']),
  listAccounts: vi.fn(async (provider: string) => data.connected.has(provider) ? [{ accountId: 'default', updatedAt: 1000, isDefault: true }] : []),
  resolveSecret: vi.fn(() => { throw new Error('Must not decrypt credentials') }),
}))
vi.mock('@gugu/session-plugins/integrations', () => ({ integrationPluginRegistry: { getAll: () => [
  { metadata: { id: 'dingtalk', name: '钉钉' } }, { metadata: { id: 'feishu', name: '飞书' } }, { metadata: { id: 'email', name: '邮箱' } },
] } }))
vi.mock('../../../apps/desktop/electron/session/main/core/provider-accounts/provider-account-registry-instance', () => ({ providerAccountRegistry: data }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations', () => ({
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
    { id: 'email:default', name: '邮箱', modifiedAt: '1970-01-01T00:00:01.000Z', isDefault: true },
  ])
  expect(data.resolveSecret).not.toHaveBeenCalled()
})

it('derives the delegation row from the live connection: it appears on connect and disappears on disconnect', async () => {
  data.connected.add('feishu')
  expect((await configuredIntegrationIndex()).find(row => row.id === 'feishu:default')).toMatchObject({
    name: '飞书', use: { note: '飞书已连接，要用就派任务', delegate: { tool: 'session_spawn' }, task_skills: ['lark-calendar', 'lark-doc'] },
  })
  data.connected.delete('feishu')
  expect((await configuredIntegrationIndex()).some(row => row.id.startsWith('feishu:'))).toBe(false)
})
