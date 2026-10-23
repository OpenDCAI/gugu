import { createGroupAdmin, type GroupAdminRpcClient, type GroupInvitationReceipt } from './groupAdmin'

/** The ordinary group-creation path shared by the app, host and agent MCP. */
export type GroupChatRpcClient = GroupAdminRpcClient

export async function createGroupChat(
  client: GroupChatRpcClient,
  name: string,
  creatorId: string,
  memberIds: string[],
  groupPrompt?: string | null,
  creatingAgentId?: string,
): Promise<string> {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Group name is required')
  const selectedMemberIds = [...new Set(memberIds)].filter((id) => id && id !== creatorId)
  if (creatingAgentId && !selectedMemberIds.includes(creatingAgentId)) throw new Error('Creating Agent must be an initial member')

  const chatId = crypto.randomUUID()
  const { data, error } = await client.rpc('create_gugu_group', {
    p_chat_id: chatId,
    p_name: normalizedName,
    p_owner_user_id: creatorId,
    p_initial_members: selectedMemberIds.map((id) => ({ user_id: id, role: id === creatingAgentId ? 'admin' : 'member' })),
    p_default_agent_type: null,
    p_group_prompt: groupPrompt?.trim() || null,
  })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (row && typeof row.id === 'string' && row.id.length > 0) return row.id
  throw new Error('create_gugu_group: database did not confirm the created group')
}

export interface GroupCreationIdentity { id: string; type: string; owner_user_id: string | null }
export interface GroupCreationResult {
  chat_id: string
  name: string
  member_user_ids: string[]
  invitations: GroupInvitationReceipt[]
  invitation_errors: Array<{ invitee_user_id: string; error: string }>
}

/** Related agents enter initially; every external identity uses the common invitation door. */
export async function createGroupWithInvitations(
  client: GroupChatRpcClient,
  name: string,
  owner: string,
  actor: string,
  identities: readonly GroupCreationIdentity[],
  groupPrompt?: string | null,
): Promise<GroupCreationResult> {
  const selected = [...new Map(identities.filter((row) => row.id !== owner).map((row) => [row.id, row])).values()]
  if (selected.some((row) => !['human', 'agent'].includes(row.type))) throw new Error('Selected group identity does not exist')
  const direct = selected.filter((row) => row.type === 'agent' && row.owner_user_id === owner).map((row) => row.id)
  // The creating Agent has management authority; its human stays the sole owner.
  const chatId = await createGroupChat(client, name, owner, direct, groupPrompt, actor === owner ? undefined : actor)
  const admin = createGroupAdmin(client, actor)
  const result: GroupCreationResult = { chat_id: chatId, name: name.trim(), member_user_ids: [owner, ...direct], invitations: [], invitation_errors: [] }
  for (const target of selected.filter((row) => !direct.includes(row.id))) {
    try {
      result.invitations.push(await admin.invite(chatId, target.id, `邀请你加入群聊「${name.trim()}」。`))
    } catch (error) {
      // The group is committed. Retrying creation would duplicate it; retain its
      // id and each failure so both callers can report the real outcome.
      result.invitation_errors.push({ invitee_user_id: target.id, error: String((error as Error).message) })
    }
  }
  return result
}
