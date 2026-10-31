export const PERMANENT_REMOVAL_RPCS = { agent: 'remove_owned_agent', device: 'remove_device' } as const

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
