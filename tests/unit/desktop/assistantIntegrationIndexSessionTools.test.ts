import { expect, it, vi } from 'vitest'
// The real plugin registry and the real "hands sessions tools" check: every connection that gives a task
// session its tools without being a CLI (hosted MCP such as AMap, MCP OAuth, mail) must say how it is used.
const data = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => [{ accountId: 'default', updatedAt: 1000, isDefault: true }]),
}))
vi.mock('../../../apps/desktop/electron/session/main/core/provider-accounts/provider-account-registry-instance', () => ({ providerAccountRegistry: data }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/integration-credential-store-instance', () => ({ integrationCredentialStore: {} }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/integration-connection-service', () => ({ integrationConnectionService: {} }))
vi.mock('../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations', async importOriginal => ({
  ...await importOriginal<typeof import('../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations')>(),
  connectedCliSkills: async () => [],
}))
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { cliMethodOf } from '../../../apps/desktop/electron/session/main/core/integrations/cli/cli-integrations'
import { integrationGivesSessionTools } from '../../../apps/desktop/electron/session/main/core/integrations/session-integrations'
import { configuredIntegrationIndex } from '../../../apps/desktop/electron/session/main/core/integrations/integration-resource-index'

it('tells the assistant to delegate every connection whose tools come with a task session, not to look in catalog_list', async () => {
  const toolApps = integrationPluginRegistry.getAll()
    .filter(plugin => integrationGivesSessionTools(plugin.metadata.id) && !cliMethodOf(plugin.metadata.id))
  expect(toolApps.map(plugin => plugin.metadata.id)).toEqual(expect.arrayContaining(['amap']))
  const rows = await configuredIntegrationIndex()
  for (const plugin of toolApps) {
    // Beta 1059.1 gave AMap neither `use` nor `note`, so the index's "otherwise via catalog_list" applied and
    // the assistant went looking for a command-line tool that was never meant to exist.
    expect(rows.find(row => row.id === `${plugin.metadata.id}:default`), plugin.metadata.id).toMatchObject({
      use: { note: `${plugin.metadata.name}已连接，要用就派任务；任务会话里自带它的工具`, delegate: { tool: 'session_spawn' }, task_skills: [] },
    })
    expect(rows.find(row => row.id === `${plugin.metadata.id}:default`), plugin.metadata.id).not.toHaveProperty('note')
  }
})
