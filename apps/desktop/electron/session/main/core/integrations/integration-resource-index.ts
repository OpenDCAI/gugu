import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { providerAccountRegistry } from '../provider-accounts/provider-account-registry-instance'
import { connectedCliSkills } from './cli/cli-integrations'
import { integrationGivesSessionTools } from './session-integrations'
import { log } from '@main/lib/logger'

/** Runs beside the active account registry; metadata and CLI skill names,
 * without decrypting credentials or starting a provider command. */
export async function configuredIntegrationIndex() {
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
    const use = taskSkills.length
      ? { note: `${plugin.metadata.name}已连接，要用就派任务`, delegate: { tool: 'session_spawn' }, task_skills: taskSkills }
      : undefined
    // Neither tools nor task skills: connected for issue links only, nothing the assistant can call.
    const note = !use && !integrationGivesSessionTools(provider) ? '只用来关联 issue，助理不能直接用' : undefined
    return accounts.map(account => ({
      id: `${provider}:${account.accountId}`, name: plugin.metadata.name,
      modifiedAt: new Date(account.updatedAt).toISOString(), isDefault: account.isDefault,
      ...(use ? { use } : {}), ...(note ? { note } : {}),
    }))
  })
}
