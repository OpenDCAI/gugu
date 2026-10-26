import { expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({
  listAccounts: vi.fn(async (provider: string) => provider === 'dingtalk' ? [{ accountId: 'default', updatedAt: 1000, isDefault: true }] : []),
  resolveSecret: vi.fn(() => { throw new Error('Must not decrypt credentials') }),
}))
vi.mock('@gugu/session-plugins/integrations', () => ({ integrationPluginRegistry: { getAll: () => [
  { metadata: { id: 'dingtalk', name: '钉钉' } }, { metadata: { id: 'feishu', name: '飞书' } },
] } }))
vi.mock('../../../apps/desktop/electron/session/main/core/provider-accounts/provider-account-registry-instance', () => ({ providerAccountRegistry: data }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations', () => ({
  connectedCliSkills: async (configured: (id: string) => Promise<boolean>) => await configured('dingtalk')
    ? [{ extensionId: 'dingtalk', name: 'dws', dir: '/installed/dws/skills/dws' }] : [],
}))
import { configuredIntegrationIndex } from '../../../apps/desktop/electron/session/main/core/integrations/integration-resource-index'

it('lists configured applications with human names and the live CLI skill pointer without resolving secrets', async () => {
  expect(await configuredIntegrationIndex()).toEqual([{
    id: 'dingtalk:default', name: '钉钉', path: '/installed/dws/skills/dws/SKILL.md',
    modifiedAt: '1970-01-01T00:00:01.000Z', isDefault: true,
  }])
  expect(data.resolveSecret).not.toHaveBeenCalled()
})
