import { createGuguSupabaseClient } from './supabase'

// @@@ cloud — see git history for full context.

// Narrow port over the two supabase ops this needs, so the decision logic is unit-testable without a
// real client. A missing active row is indeterminate: the owner-scoped removal RPC distinguishes an
// owned tombstone (idempotent success) from an unauthorized/unknown id (explicit error).
export interface AgentIdentityRemovalClient {
  getAgentHomeDevice(agentUserId: string): Promise<{ deviceId: string | null } | null>
  removeOwnedAgent(agentUserId: string): Promise<{ error: string | null }>
}

export interface RemoveAgentCloudIdentityInput {
  agentUserId: string
  deviceId: string
  client: AgentIdentityRemovalClient
}

export type RemoveAgentCloudIdentityOutcome =
  | { removed: true }
  | { removed: false; reason: 'not-owned'; message?: string }
  | { removed: false; reason: 'not-homed'; message?: string }
  | { removed: false; reason: 'error'; message?: string }

// Pure decision logic over the injected client. Home-guard: only delete when we POSITIVELY know this
// device is the agent's home. A read that comes back indeterminate (network/RLS hiccup) proceeds —
// remove_owned_agent is itself owner-scoped, so proceeding is still safe.
export async function removeAgentCloudIdentity(
  input: RemoveAgentCloudIdentityInput
): Promise<RemoveAgentCloudIdentityOutcome> {
  let homeDeviceId: string | null = null
  let readIndeterminate = false
  try {
    const row = await input.client.getAgentHomeDevice(input.agentUserId)
    if (row !== null) homeDeviceId = row.deviceId
    else readIndeterminate = true
  } catch {
    readIndeterminate = true
  }

  if (!readIndeterminate && homeDeviceId && homeDeviceId !== input.deviceId) {
    return {
      removed: false,
      reason: 'not-homed',
      message: `agent is homed on device ${homeDeviceId}, not this device (${input.deviceId}); cloud identity left intact`
    }
  }

  try {
    const { error } = await input.client.removeOwnedAgent(input.agentUserId)
    if (error) {
      // "Agent is not owned by current user" means it's already gone (or never ours) — idempotent no-op.
      if (/\bnot owned\b/i.test(error)) {
        return { removed: false, reason: 'not-owned', message: error }
      }
      return { removed: false, reason: 'error', message: error }
    }
    return { removed: true }
  } catch (err) {
    return { removed: false, reason: 'error', message: (err as Error).message }
  }
}

// Thin supabase adapter: builds an owner-authenticated identity-schema client and the two port methods.
// `getAgentHomeDevice` returns null when no active row is visible; the RPC remains the authority for
// deciding whether that means an owned tombstone or an unauthorized id.
export interface RemoveAgentCloudIdentityViaSupabaseInput {
  agentUserId: string
  accessToken: string
  deviceId: string
  fetch?: typeof fetch
}

export async function removeAgentCloudIdentityViaSupabase(
  input: RemoveAgentCloudIdentityViaSupabaseInput
): Promise<RemoveAgentCloudIdentityOutcome> {
  const client = createGuguSupabaseClient({
    schema: 'identity',
    headers: { Authorization: `Bearer ${input.accessToken}` },
    fetch: input.fetch
  })

  const port: AgentIdentityRemovalClient = {
    async getAgentHomeDevice(agentUserId: string) {
      const { data, error } = await client
        .from('users')
        .select('device_id')
        .eq('id', agentUserId)
        .eq('type', 'agent')
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return null
      return { deviceId: (data as { device_id?: string | null }).device_id ?? null }
    },
    async removeOwnedAgent(agentUserId: string) {
      const { error } = await client.rpc('remove_owned_agent', { p_agent_user_id: agentUserId })
      return { error: error ? (error as { message?: string }).message ?? String(error) : null }
    }
  }

  return removeAgentCloudIdentity({
    agentUserId: input.agentUserId,
    deviceId: input.deviceId,
    client: port
  })
}
