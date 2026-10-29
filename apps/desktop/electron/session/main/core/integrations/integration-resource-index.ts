import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { providerAccountRegistry } from '../provider-accounts/provider-account-registry-instance'
import { cliMethodOf, connectedCliSkills } from './cli/cli-integrations'
import { platformCredentials } from './platform-credentials-instance'
import { integrationGivesSessionTools } from './session-integrations'
import { log } from '@main/lib/logger'

/** Runs beside the active account registry; metadata and CLI skill names,
 * without decrypting credentials or starting a provider command. Credentials the
 * platform keeps (#921) are asked of the platform first, so a connection made on
 * another device of the person's is listed here too. */
export async function configuredIntegrationIndex() {
  await platformCredentials.refresh()
  const configured = await Promise.all(integrationPluginRegistry.getAll().map(async plugin => ({
    plugin, accounts: await providerAccountRegistry.listAccounts(plugin.metadata.id),
  })))
  const providers = new Set(configured.filter(row => row.accounts.length).map(row => row.plugin.metadata.id))
  const skills = await connectedCliSkills(async provider => providers.has(provider), () => {
    log.warn('Connected integration skill metadata is unavailable')
  })
  return configured.flatMap(({ plugin, accounts }) => {
    const provider = plugin.metadata.id
    const taskSkills = skills.filter(skill => skill.extensionId === provider).map(skill => skill.name)
    // The assistant has no shell or Skill tool: a connected CLI application is used by the task it delegates.
    // A connection that hands sessions its tools (hosted MCP such as AMap, MCP OAuth, mail) is used the same
    // way: a task session opened now carries them. ❌ "via catalog_list": they are never in the catalog.
    const use = taskSkills.length
      ? { note: `${plugin.metadata.name}已连接，要用就派任务`, delegate: { tool: 'session_spawn' }, task_skills: taskSkills }
      : !cliMethodOf(provider) && integrationGivesSessionTools(provider)
        ? { note: `${plugin.metadata.name}已连接，要用就派任务；任务会话里自带它的工具`, delegate: { tool: 'session_spawn' }, task_skills: [] }
        : undefined
    // Neither tools nor a CLI: connected for issue links only, nothing the assistant can call.
    // A CLI whose skills cannot be read right now is still a CLI, not an issue link.
    const note = !use && !cliMethodOf(provider) && !integrationGivesSessionTools(provider) ? '只用来关联 issue，助理不能直接用' : undefined
    return accounts.map(account => ({
      id: `${provider}:${account.accountId}`, name: plugin.metadata.name,
      modifiedAt: new Date(account.updatedAt).toISOString(), isDefault: account.isDefault,
      // #921 kept but not usable now (rejected): a task would get no tools; only the person can fix it.
      ...(platformCredentials.needsReconnect(provider, account)
        ? { note: `${plugin.metadata.name}要重新连接，现在用不了；请他到连接页处理` }
        : { ...(use ? { use } : {}), ...(note ? { note } : {}) }),
    }))
  })
}
