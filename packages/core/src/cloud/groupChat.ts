/** The ordinary group-creation path shared by the app and agent MCP. */
export interface GroupChatRpcClient {
  rpc(name: 'create_gugu_group', args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { message: string } | null
  }>
}

export async function createGroupChat(
  client: GroupChatRpcClient,
  name: string,
  creatorId: string,
  memberIds: string[],
  groupPrompt?: string | null,
): Promise<string> {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Group name is required')
  const selectedMemberIds = [...new Set(memberIds)].filter((id) => id && id !== creatorId)
  if (selectedMemberIds.length < 1) throw new Error('Group chat requires at least 1 invited member')

  const chatId = crypto.randomUUID()
  const { data, error } = await client.rpc('create_gugu_group', {
    p_chat_id: chatId,
    p_name: normalizedName,
    p_owner_user_id: creatorId,
    p_initial_members: selectedMemberIds.map((id) => ({ user_id: id, role: 'member' })),
    p_default_agent_type: null,
    p_group_prompt: groupPrompt?.trim() || null,
  })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (row && typeof row.id === 'string' && row.id.length > 0) return row.id
  return chatId
}
