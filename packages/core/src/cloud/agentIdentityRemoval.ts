export const PERMANENT_REMOVAL_RPCS = { agent: 'remove_owned_agent', device: 'remove_device' } as const

/** The retained identity row is the removal fact; membership rows are never written here. */
export async function archiveIdentity(client: {
  rpc(name: 'archive_user', args: { p_user_id: string; p_remove_social_identity: boolean }): PromiseLike<{ data: unknown; error: { message: string } | null }>
}, userId: string, removeSocialIdentity = true): Promise<{ userId: string; removedAt: string | null }> {
  const { data, error } = await client.rpc('archive_user', { p_user_id: userId, p_remove_social_identity: removeSocialIdentity })
  if (error) throw new Error(error.message, { cause: error })
  const receipt = data as { user_id?: unknown; removed_at?: unknown; remove_social_identity?: unknown } | null
  if (receipt?.user_id !== userId || receipt.remove_social_identity !== removeSocialIdentity
    || (removeSocialIdentity ? typeof receipt.removed_at !== 'string' || !Number.isFinite(Date.parse(receipt.removed_at)) : receipt.removed_at !== null)) {
    throw new Error('Identity archival receipt does not match the requested identity and option')
  }
  return { userId, removedAt: receipt.removed_at as string | null }
}

type RemovalResult = PromiseLike<{ error: { message: string } | null }>
type AgentRemoval = { agentId: string; client: { rpc(name: 'remove_owned_agent', args: { p_agent_user_id: string }): RemovalResult } }
type DeviceRemoval = { deviceId: string; cascade?: boolean; client: { rpc(name: 'remove_device', args: { p_device_id: string; p_cascade: boolean }): RemovalResult } }

/** Explicit permanent removal. Callers use their existing confirmation UI and backend authorization. */
export async function permanentlyRemove(target: AgentRemoval | DeviceRemoval): Promise<void> {
  const { error } = 'agentId' in target
    ? await target.client.rpc(PERMANENT_REMOVAL_RPCS.agent, { p_agent_user_id: target.agentId })
    : await target.client.rpc(PERMANENT_REMOVAL_RPCS.device, { p_device_id: target.deviceId, p_cascade: target.cascade ?? false })
  if (error) throw new Error(error.message, { cause: error })
}
