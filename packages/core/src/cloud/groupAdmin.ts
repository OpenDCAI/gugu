/** Shared human/agent group transport. Authorization belongs to the database. */
export interface GroupAdminRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { message: string } | null
  }>
}

export interface GroupInfo extends Record<string, unknown> {
  id: string
  my_role: 'owner' | 'admin' | 'member' | null
  can_manage: boolean
  can_dissolve: boolean
}

export type GroupMemberRole = 'admin' | 'member'
export type GroupJoinStatus = 'joined' | 'pending_approval' | 'already_member'
export interface GroupJoinReceipt extends Record<string, unknown> {
  chat_id: string
  status: GroupJoinStatus
}
export interface GroupInvitationReceipt extends Record<string, unknown> {
  chat_id: string
  status: GroupJoinStatus | 'pending' | 'accepted' | 'rejected'
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${operation}: database returned no authoritative result`)
  }
  return value as Record<string, unknown>
}

/** actor is supplied by the authenticated app or trusted MCP session, never a model argument. */
export function createGroupAdmin(client: GroupAdminRpcClient, actor: string) {
  if (!actor.trim()) throw new Error('A group operation requires an explicit actor')

  async function call(response: ReturnType<GroupAdminRpcClient['rpc']>): Promise<unknown> {
    const { data, error } = await response
    if (error) throw new Error(error.message)
    return data
  }
  async function object(name: string, response: ReturnType<GroupAdminRpcClient['rpc']>, expected: Record<string, unknown> = {}) {
    const row = record(await call(response), name)
    for (const [key, value] of Object.entries(expected)) {
      if (row[key] !== value) throw new Error(`${name}: database did not confirm ${key}`)
    }
    return row
  }
  async function list(name: string, response: ReturnType<GroupAdminRpcClient['rpc']>) {
    const rows = await call(response)
    if (!Array.isArray(rows)) throw new Error(`${name}: database returned no list`)
    return rows.map((row) => record(row, name))
  }
  function infoResult(row: Record<string, unknown>): GroupInfo {
    if (typeof row.can_manage !== 'boolean' || typeof row.can_dissolve !== 'boolean') {
      throw new Error('group_info_as: database returned no capabilities')
    }
    return row as GroupInfo
  }

  return {
    async info(chatId: string): Promise<GroupInfo> {
      return infoResult(await object('group_info_as', client.rpc('group_info_as', { p_chat_id: chatId, p_as_user_id: actor }), { id: chatId }))
    },
    async remove(chatId: string, member: string) {
      const row = await object('remove_group_member_as', client.rpc('remove_group_member_as', { p_chat_id: chatId, p_member_user_id: member, p_as_user_id: actor }), { chat_id: chatId, user_id: member })
      if (!['removed', 'already_absent'].includes(String(row.status))) throw new Error('remove_group_member_as: removal was not confirmed')
      return row
    },
    async setRole(chatId: string, member: string, role: GroupMemberRole) {
      return object('set_group_member_role_as', client.rpc('set_group_member_role_as', { p_chat_id: chatId, p_member_user_id: member, p_role: role, p_as_user_id: actor }), { chat_id: chatId, user_id: member, role })
    },
    async setListenMode(chatId: string, agent: string, mode: 'active' | 'passive') {
      return object('set_agent_listen_mode_as', client.rpc('set_agent_listen_mode_as', { p_chat_id: chatId, p_agent_user_id: agent, p_mode: mode, p_as_user_id: actor }), { chat_id: chatId, user_id: agent, listen_mode: mode })
    },
    async update(chatId: string, changes: Record<string, unknown>): Promise<GroupInfo> {
      return infoResult(await object('update_group_as', client.rpc('update_group_as', { p_chat_id: chatId, p_changes: changes, p_as_user_id: actor }), { id: chatId }))
    },
    async archive(chatId: string) {
      return object('archive_group_as', client.rpc('archive_group_as', { p_chat_id: chatId, p_as_user_id: actor }), { chat_id: chatId, status: 'archived' })
    },
    async joinRequests(chatId: string, includeDecided = true) {
      return list('list_group_join_requests', client.rpc('list_group_join_requests', { p_chat_id: chatId, p_include_decided: includeDecided, p_as_user_id: actor }))
    },
    async decideJoin(requestId: string, accept: boolean) {
      return object('decide_group_join', client.rpc('decide_group_join', { p_request_id: requestId, p_accept: accept, p_as_user_id: actor }), { request_id: requestId, status: accept ? 'accepted' : 'rejected' })
    },
    async addAgent(chatId: string, agent: string): Promise<GroupJoinReceipt> {
      const row = await object('add_group_agent', client.rpc('add_group_agent', { p_chat_id: chatId, p_agent_user_id: agent, p_message: null, p_as_user_id: actor }), { chat_id: chatId })
      if (!['joined', 'pending_approval', 'already_member'].includes(String(row.status))) throw new Error('add_group_agent: unexpected membership result')
      return row as GroupJoinReceipt
    },
    async invite(chatId: string, target: string, text: string): Promise<GroupInvitationReceipt> {
      const row = await object('request_group_invitation_as', client.rpc('request_group_invitation_as', { p_chat_id: chatId, p_invitee_user_id: target, p_message: text, p_as_user_id: actor }), { chat_id: chatId })
      if (!['joined', 'pending', 'already_member', 'pending_approval'].includes(String(row.status))) throw new Error('request_group_invitation_as: invitation was not confirmed')
      return row as GroupInvitationReceipt
    },
    async invitations(sent: boolean, includeDecided = true) {
      return list('list_group_invitations_as', client.rpc('list_group_invitations_as', { p_sent: sent, p_include_decided: includeDecided, p_as_user_id: actor }))
    },
    async decideInvitation(invitationId: string, accept: boolean) {
      const row = await object('decide_group_invitation_as', client.rpc('decide_group_invitation_as', { p_invitation_id: invitationId, p_accept: accept, p_as_user_id: actor }), { invitation_id: invitationId })
      if (!(accept ? ['accepted', 'pending_approval'] : ['rejected']).includes(String(row.status))) {
        throw new Error('decide_group_invitation_as: invitation decision was not confirmed')
      }
      return row
    },
    async postAnnouncement(chatId: string, text: string) {
      const row = await object('post_group_announcement_as', client.rpc('post_group_announcement_as', { p_chat_id: chatId, p_text: text, p_as_user_id: actor }), { chat_id: chatId })
      if (typeof row.id !== 'string' || !row.id) throw new Error('post_group_announcement_as: announcement was not confirmed')
      return row
    },
    async updateAnnouncement(id: string, changes: { content?: string; pinned?: boolean }) {
      return object('update_group_announcement_as', client.rpc('update_group_announcement_as', { p_announcement_id: id, p_changes: changes, p_as_user_id: actor }), { id })
    },
    async deleteAnnouncement(id: string) {
      return object('delete_group_announcement_as', client.rpc('delete_group_announcement_as', { p_announcement_id: id, p_as_user_id: actor }), { id, status: 'deleted' })
    },
    async undoFlood(id: string) {
      const rows = await list('undo_agent_flood_adjustment', client.rpc('undo_agent_flood_adjustment', { p_adjustment_id: id, p_as_user_id: actor }))
      const row = rows[0]
      if (rows.length !== 1 || row?.adjustment_id !== id || typeof row.restored !== 'number') throw new Error('undo_agent_flood_adjustment: restoration was not confirmed')
      return row
    },
  }
}

/** Both transports upload the same validated asset and save all storage references together. */
export async function setGroupAvatar(
  admin: ReturnType<typeof createGroupAdmin>,
  chatId: string,
  uploaderUserId: string,
  file: File,
  upload: (path: string, file: File) => Promise<string>,
): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Group avatar must be an image')
  if (file.size > 5 * 1024 * 1024) throw new Error('Group avatar must not exceed 5 MB')
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'image'
  const path = `${uploaderUserId}/group-avatar/${crypto.randomUUID()}-${safeName}`
  const url = await upload(path, file)
  const row = await admin.update(chatId, {
    avatar_url: url, avatar_storage_bucket_id: 'chat-media', avatar_storage_object_name: path,
  })
  if (row.avatar_url !== url) throw new Error('update_group_as: avatar was not confirmed')
  return url
}
