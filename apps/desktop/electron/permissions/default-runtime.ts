import { privateServicePermissionDirectory } from '@gugu/core/local/state/agentFileBoundary'
import { anySignal } from '@gugu/core/shared/anySignal'
import type { VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { currentAccountAccessToken } from '../session/main/core/extensions/account-token'
import { createLogger } from '../lib/logger'
import { PrivatePermissionRecords } from './private-records'
import { ServicePermissionPolicyStore } from './policy-store'
import { ServicePermissionRuntime } from './runtime'
import type { PermissionPolicy } from './rules'

let runtime: ServicePermissionRuntime | undefined
export function defaultServicePermissionRuntime(): ServicePermissionRuntime {
  const observations = new Map<string, { policy: PermissionPolicy | null; at: number; pending?: Promise<void> }>()
  return runtime ??= new ServicePermissionRuntime({
    records: new PrivatePermissionRecords(privateServicePermissionDirectory()),
    async readPolicy(caller, signal, mode) {
      signal.throwIfAborted()
      const token = await currentAccountAccessToken()
      if (!token) return null
      // The token comes from the host's authenticated account reader, never the MCP request.
      const owner = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown }
      if (owner.sub !== caller.ownerId) return null
      for (const ownerId of observations.keys()) if (ownerId !== caller.ownerId) observations.delete(ownerId)
      const load = async (lifetime: AbortSignal) => {
        const { makeIdentityClient } = await import('../supabase')
        const store = new ServicePermissionPolicyStore(makeIdentityClient(token) as unknown as VersionedSettingsTableClient)
        const policy = await store.read(caller.ownerId, lifetime)
        lifetime.throwIfAborted()
        return policy
      }
      if (mode === 'enforce') return { policy: await load(anySignal([signal, AbortSignal.timeout(5000)])), knownSecrets: [token] }
      // Observation is diagnostic: never wait on cloud I/O in the person's existing tool path.
      // An unavailable/initial snapshot is explicitly recorded as policy_unavailable, never as an allow.
      const cached: { policy: PermissionPolicy | null; at: number; pending?: Promise<void> } = observations.get(caller.ownerId) ?? { policy: null, at: 0 }
      observations.set(caller.ownerId, cached)
      if (!cached.pending && Date.now() - cached.at >= 5000) {
        cached.at = Date.now()
        cached.pending = load(AbortSignal.timeout(5000))
          .then(policy => { cached.policy = policy }, () => { cached.policy = null })
          .finally(() => { cached.pending = undefined })
      }
      return { policy: cached.policy, knownSecrets: [token] }
    },
    recordFailure: () => createLogger('service-permissions').warn({ code: 'private_record_unavailable' }, 'Service permission observation could not be recorded'),
  })
}
