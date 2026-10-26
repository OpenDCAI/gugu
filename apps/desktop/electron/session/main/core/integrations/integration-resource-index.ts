import { join } from 'node:path'
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { providerAccountRegistry } from '../provider-accounts/provider-account-registry-instance'
import { connectedCliSkills } from './cli/cli-integrations'
import { log } from '@main/lib/logger'

/** Runs beside the active account registry; metadata and CLI skill pointers,
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
    const skill = skills.find(skill => skill.extensionId === provider)
    return accounts.map(account => ({
      id: `${provider}:${account.accountId}`, name: plugin.metadata.name,
      ...(skill ? { path: join(skill.dir, 'SKILL.md') } : {}),
      modifiedAt: new Date(account.updatedAt).toISOString(), isDefault: account.isDefault,
    }))
  })
}
