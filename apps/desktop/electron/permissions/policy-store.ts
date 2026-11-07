import { readUserSettingsConfig, updateUserSettingsConfig, type VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { defaultPermissionPolicy, parsePermissionPolicy, type PermissionPolicy } from './rules'
import { requirePermissionOwner, type PersonPrincipal } from './private-records'
import { beginPermissionPolicyWrite } from './policy-write-lifetime'

export const SERVICE_PERMISSION_SETTINGS_KEY = 'service_permissions'

/** Reuses account settings' RLS and compare-and-set, rather than a second synchronization protocol. No allow cache. */
export class ServicePermissionPolicyStore {
  constructor(private readonly client: VersionedSettingsTableClient) {}
  async read(ownerId: string, signal?: AbortSignal): Promise<PermissionPolicy> {
    const config = await readUserSettingsConfig(this.client, ownerId, 'user', signal)
    return config[SERVICE_PERMISSION_SETTINGS_KEY] === undefined ? defaultPermissionPolicy() : parsePermissionPolicy(config[SERVICE_PERMISSION_SETTINGS_KEY])
  }
  async write(principal: PersonPrincipal, ownerId: string, policy: PermissionPolicy): Promise<void> {
    requirePermissionOwner(principal, ownerId)
    const parsed = parsePermissionPolicy(policy)
    const finish = beginPermissionPolicyWrite(ownerId)
    try {
      await updateUserSettingsConfig(this.client, ownerId, 'user', config => {
        const current = config[SERVICE_PERMISSION_SETTINGS_KEY] === undefined ? defaultPermissionPolicy() : parsePermissionPolicy(config[SERVICE_PERMISSION_SETTINGS_KEY])
        if (current.revision !== parsed.revision) throw new Error('Service permissions changed; reload before saving')
        return { ...config, [SERVICE_PERMISSION_SETTINGS_KEY]: { ...parsed, revision: current.revision + 1 } }
      })
    } finally { finish() }
  }
}
