import { permanentlyRemove } from '@gugu/core/cloud/agentIdentityRemoval'
import { updateDisplayAlias } from './displayOverrides'
import { messageForUser } from './userFacingError'
import { dbPayload } from '@gugu/core/cloud/supabase'
import { fetchInChunks, compareIsoDescNullsLast } from '@gugu/core/shared/inChunks'
import { dataClient, identityDb, chatDb, getCurrentAuthUserId } from './supabase'
import { fallbackChatName } from '@gugu/core/shared/ui/chatModels'
import {
  agentAvatarStoragePath,
  managedAgentAvatarPath,
  validateAgentAvatarFile,
} from './agentAvatar'
import type { GroupAvatarMember, GroupMemberRole } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'
import { updateOwnedAgentIdentity } from '@gugu/core/cloud/ownedAgent'
import { taskAgentName } from '@gugu/core/shared/taskAgentName'
import { liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { isMyAssistant } from './myAssistant'
import { buildLookUrl, lookObjectPath, type AgentLook } from '@/components/agentAvatar/look'

import { DISPLAY_IDENTITY_SELECT, readAgentProfileTypes, readDisplayIdentities, readOwnedDisplayIdentities, readRequiredDisplayIdentities } from './identityReadAdapter'
import type {
  AcceptFriendRequestResult,
  ContactGroup,
  ContactGroupChat,
  ContactUser,
  FriendRequest,
  FriendRequestStatus,
  PublicGroupInviteGroup,
  PublicGroupInviteLookupResult,
  PublicGroupJoinResult,
  DiscoverableGroup,
} from '@gugu/core/shared/types/contacts'

// 「新的请求」的好友申请:待处理的全读(按钮与角标靠它);已处理的只取最近 FRIEND_REQUEST_HISTORY_LIMIT 条、新的在前 ——
// 历史无界,不排序不限量会被 PostgREST 的行数上限截成任意子集,连待处理的都可能被截掉。
const FRIEND_REQUEST_SELECT = 'id, sender_id, receiver_id, message, status, created_at'
const FRIEND_REQUEST_HISTORY_LIMIT = 100

const identity = () => dataClient.schema('identity')
const chat = () => dataClient.schema('chat')

// @@@no-email-select (#635) - email is PII and MUST NOT be fetched for peers. identity.users RLS is
// @@@1761 device_id:云 agent 判定(isCloudAgentMarked)需要——好友的云 agent 无 agent_type 富化,只有 'cloud:' 前缀可判
const GROUP_CHAT_SELECT = 'id, public_id, kind, name, avatar_url'

// @@@1752 — last_message_at 仅为分批合并后的客户端重排而 select（DB 排序在 chunk 间无意义）。
type GroupChatRow = {
  id: string
  public_id: number | null
  kind: 'group'
  name: string | null
  avatar_url: string | null
  last_message_at: string | null
}

// @@@1752 — getCommonGroupChats 的「分批取活跃群 + last_message_at 客户端重排」。fail-loud：任一 chunk error 即整体 throw（原语义）。
async function fetchActiveGroupChats(ids: string[]): Promise<GroupChatRow[]> {
  const rows = await fetchInChunks(ids, async (chunk) => {
    const { data, error } = await chat()
      .from('chats')
      .select(`${GROUP_CHAT_SELECT}, last_message_at`)
      .in('id', chunk)
      .in('kind', ['group'])
      .eq('status', 'active')
    if (error) throw new Error(messageForUser(error), { cause: error })
    return (data as GroupChatRow[] | null) ?? []
  })
  return rows.sort((a, b) => compareIsoDescNullsLast(a.last_message_at, b.last_message_at))
}

type ContactOverrideRow = {
  target_id: string
  alias: string | null
}

type ContactGroupRow = {
  id: string
  owner_user_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

type ContactGroupMemberRow = {
  group_id: string
  contact_user_id: string
}

type AgentProfileRow = {
  id: string
  agent_type: 'codex' | 'claude-code' | null
}

type ContactUserRow = ContactUser & { local_path?: string | null }

type ContactGroupInsert = ContactGroupRow

type ContactGroupPatch = {
  name: string
  updated_at: string
}

type ContactGroupMemberInsert = ContactGroupMemberRow

type ChatMemberMuteRow = {
  chat_id: string
  notification_level: unknown
  // @@@1694 当前用户在该群的角色，用于通讯录群行右键菜单角色化（owner→解散 / member→退出）。
  role?: GroupMemberRole | null
}

type FriendRequestInsert = {
  sender_id: string
  receiver_id: string
  // @@@1505 申请附言（选填，理由/打招呼）。message 列与读取 select 早已存在(005)，只是发起侧没传过。
  message?: string | null
}

type AcceptFriendRequestRow = {
  chat_id: string | null
  name: string | null
  kind: 'group' | null
  created: boolean | null
}

type PublicGroupInviteRpcRow = {
  chat_id: string | null
  public_id: number | null
  kind: 'group' | null
  name: string | null
  member_count: number | null
  is_member: boolean | null
  is_muted: boolean | null
  // @@@group-join-mode (#1018 step3 #858) — lookup_public_group 返回这两列；
  // join_public_group 仍返回旧 7 列（不含这两列）→ 这里可缺省，normalize 兜底。
  join_mode?: string | null
  join_request_status?: string | null
}

// @@@1175 — search_discoverable_groups RPC 返回行。
type DiscoverableGroupRpcRow = {
  chat_id: string
  public_id: number
  name: string | null
  description: string | null
  avatar_url: string | null
  member_count: number | null
  is_member: boolean | null
  join_mode: string | null
  join_request_status: string | null
  join_token: string | null
  invite_link_enabled: boolean | null
  creator_name: string | null
  member_avatars: unknown
}

// @@@group-avatar-tile — 广场行的群头像走产品统一链路（显式群头像 > 成员组合 > 空态），组合格由
// search_discoverable_groups 以 jsonb 带出（非成员读不到 chat_members，客户端补不了这段）。
// 严格解析：形状不对就报错停，❌ 不静默丢格——丢格会让组合的格数与 member_count 对不上 = 用视觉撒谎。
function parseGroupAvatarMembers(raw: unknown): GroupAvatarMember[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('search_discoverable_groups returned a non-array member_avatars')
  return raw.map((tile) => {
    const row = tile as { id?: unknown; name?: unknown; avatar?: unknown } | null
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (!id) throw new Error('search_discoverable_groups returned a member_avatars tile without a stable id')
    return {
      id,
      name: typeof row?.name === 'string' ? row.name : '',
      avatar: typeof row?.avatar === 'string' ? row.avatar : null,
    }
  })
}

async function normalizeAcceptFriendRequestResult(data: AcceptFriendRequestRow | AcceptFriendRequestRow[] | null): Promise<AcceptFriendRequestResult> {
  const row = Array.isArray(data) ? data[0] : data
  const chatId = row?.chat_id ?? null
  const memberCount = chatId ? requireChatMemberCount(await loadChatMemberIds([chatId]), chatId) : null
  return {
    chatId,
    name: row?.name ?? null,
    kind: row?.kind ?? null,
    created: Boolean(row?.created),
    member_count: memberCount,
  }
}

async function loadChatMemberIds(chatIds: string[]): Promise<Map<string, string[]>> {
  if (chatIds.length === 0) return new Map()
  // @@@exact-member-count - UI labels this as an exact member count, so avoid paginated
  // row-counting. Tally per chat_id client-side.
  // @@@1752 — chunked like #1666 (unbounded chat id list in one `.in()` → ~8KB GET URL → net::ERR_FAILED).
  const data = await fetchInChunks(chatIds, async (chunk) => {
    const { data: rows, error } = await chat()
      .from('chat_members')
      .select('chat_id, user_id, joined_at')
      .in('chat_id', chunk)
      .order('joined_at', { ascending: true })
      .order('user_id', { ascending: true })
    if (error) throw new Error(messageForUser(error), { cause: error })
    return (rows as { chat_id: string; user_id: string }[] | null) ?? []
  })
  const members = new Map<string, string[]>(chatIds.map((id) => [id, []]))
  for (const row of data) {
    members.get(row.chat_id)?.push(row.user_id)
  }
  return members
}

function requireChatMemberCount(members: Map<string, string[]>, chatId: string): number {
  const ids = members.get(chatId)
  if (!ids) throw new Error(`Missing members for chat ${chatId}`)
  return ids.length
}

function requireChatMemberMuted(members: Map<string, ChatMemberMuteRow>, chatId: string): boolean {
  const member = members.get(chatId)
  if (!member || member.notification_level == null) throw new Error(`Missing notification level for chat ${chatId}`)
  if (typeof member.notification_level !== 'string') throw new Error(`Invalid notification level for chat ${chatId}`)
  return member.notification_level === 'none'
}

function requirePositivePublicId(publicId: number): number {
  if (!Number.isInteger(publicId) || publicId <= 0) {
    throw new Error('Public group lookup requires a positive integer publicId')
  }
  return publicId
}

function normalizePublicGroupInviteRow(row: PublicGroupInviteRpcRow): PublicGroupInviteGroup {
  if (!row.chat_id) throw new Error('Public group lookup returned no chat id')
  if (row.public_id == null || !Number.isInteger(row.public_id) || row.public_id <= 0) {
    throw new Error(`Public group lookup returned invalid public id for chat ${row.chat_id}`)
  }
  if (row.kind !== 'group') {
    throw new Error(`Public group lookup returned invalid kind for chat ${row.chat_id}`)
  }
  if (row.member_count == null || !Number.isInteger(row.member_count) || row.member_count < 0) {
    throw new Error(`Public group lookup returned invalid member count for chat ${row.chat_id}`)
  }
  if (typeof row.is_member !== 'boolean') {
    throw new Error(`Public group lookup returned invalid membership state for chat ${row.chat_id}`)
  }
  if (row.is_muted != null && typeof row.is_muted !== 'boolean') {
    throw new Error(`Public group lookup returned invalid muted state for chat ${row.chat_id}`)
  }
  return {
    id: row.chat_id,
    public_id: row.public_id,
    kind: row.kind,
    name: row.name ?? fallbackChatName(row.kind),
    member_count: row.member_count,
    is_member: row.is_member,
    is_muted: row.is_muted,
    // @@@group-join-mode (#1018 step3 #858) — join_public_group 旧返回无这两列 → 缺省兜底（open/无请求）。
    join_mode:
      row.join_mode === 'approval' || row.join_mode === 'invite_only' ? row.join_mode : 'open',
    join_request_status:
      row.join_request_status === 'pending' ||
      row.join_request_status === 'accepted' ||
      row.join_request_status === 'rejected'
        ? row.join_request_status
        : null,
  }
}

function firstRpcRow<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? data[0] ?? null : data
}

async function enrichAgentMetadata(users: ContactUser[], currentUserId: string): Promise<ContactUser[]> {
  const ownedAgentIds = new Set(users
    .filter((user) => user.type === 'agent' && user.owner_user_id === currentUserId)
    .map((user) => user.id))

  if (ownedAgentIds.size === 0) return users

  const profileById = new Map(
    (await readAgentProfileTypes(currentUserId) as AgentProfileRow[])
      .filter((profile) => ownedAgentIds.has(profile.id))
      .map((profile) => [profile.id, profile]),
  )

  return users.map((user) => {
    const contact = user as ContactUserRow
    const profile = profileById.get(user.id)
    if (!profile) return contact
    return {
      ...contact,
      agent_type: profile.agent_type,
      project_path: contact.local_path ?? null,
    }
  })
}

// 按群号加群的可穷举结局。RPC 抛的是稳定 ASCII 标识(❌ 不是给人看的话),UI 据此选自己的文案。
const JOIN_BY_ID_REFUSALS = ['group_self_serve_closed', 'group_invite_only', 'group_not_found'] as const
export type JoinGroupByIdRefusal = typeof JOIN_BY_ID_REFUSALS[number]
export type JoinGroupByIdOutcome =
  | PublicGroupJoinResult
  | { status: 'refused'; reason: JoinGroupByIdRefusal }

/**
 * 凭邀请链接直接入群被服务端拒(join_public_group 抛的稳定 ASCII 标识):群主关了自助入群 / 该群仅限邀请。
 * 这是正常结果,不是故障 —— 抛成可穷举的类型,让 UI 翻成产品文案,❌ 把服务端原文贴给用户。
 */
export class GroupJoinRefusedError extends Error {
  constructor(public readonly reason: 'invite_only' | 'invite_link_closed') {
    super(reason)
    this.name = 'GroupJoinRefusedError'
  }
}

export const contactsService = {
  async lookupPublicGroupInvite(publicId: number): Promise<PublicGroupInviteLookupResult> {
    const { data, error } = await chatDb.rpc('lookup_public_group', {
      p_public_id: requirePositivePublicId(publicId),
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    const row = firstRpcRow(data as PublicGroupInviteRpcRow[] | PublicGroupInviteRpcRow | null)
    if (!row) return { status: 'not_found', group: null }

    const group = normalizePublicGroupInviteRow(row)
    return {
      status: group.is_member ? 'joined' : 'available',
      group,
    }
  },

  // @@@direct-join (#653) - token-gated direct join. The QR carries the group's unguessable
  async joinPublicGroup(publicId: number, joinToken: string): Promise<PublicGroupJoinResult> {
    const token = joinToken?.trim()
    if (!token) throw new Error('Joining a public group requires an invite token')
    const { data, error } = await chatDb.rpc('join_public_group', {
      p_public_id: requirePositivePublicId(publicId),
      p_join_token: token,
    })
    if (error) {
      // 服务端按 join_mode 把关(邀请 token 不再绕过「需审批 / 仅邀请」)。界面拿到的群快照可能已过时
      // (群主刚把 open 改成 approval):需审批 ⇒ 改走申请,用户看到「已提交申请」,而不是一句报错。
      if (error.message?.includes('group_join_requires_approval')) return this.requestGroupJoin(publicId, token)
      if (error.message?.includes('group_invite_only')) throw new GroupJoinRefusedError('invite_only')
      if (error.message?.includes('group_self_serve_closed')) throw new GroupJoinRefusedError('invite_link_closed')
      throw new Error(messageForUser(error), { cause: error })
    }
    const row = firstRpcRow(data as PublicGroupInviteRpcRow[] | PublicGroupInviteRpcRow | null)
    if (!row) throw new Error('Public group join returned no group')
    return { status: 'joined', group: normalizePublicGroupInviteRow(row) }
  },

  // @@@group-join-mode (#1018 step3 #858) — approval 群凭 token 提交加入请求。
  // RPC 据 join_mode 分流：open→直接入群('joined')、approval→建/复活 pending 请求('pending')、
  // invite_only→抛错。返回后回查群状态以刷新 UI（成员数 / 本人请求状态）。
  async requestGroupJoin(
    publicId: number,
    joinToken: string,
    message?: string | null
  ): Promise<PublicGroupJoinResult> {
    const token = joinToken?.trim()
    if (!token) throw new Error('Joining a public group requires an invite token')
    const id = requirePositivePublicId(publicId)
    const { data, error } = await chatDb.rpc('request_group_join', {
      p_public_id: id,
      p_join_token: token,
      p_message: message?.trim() || null,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    const status = data === 'joined' ? 'joined' : 'pending'
    const lookup = await this.lookupPublicGroupInvite(id)
    if (!lookup.group) throw new Error('Public group join returned no group')
    return { status, group: lookup.group }
  },

  // 按群号申请加群 —— 与「加好友」对称的那条路：知道群号 → 看到群 → 发申请 → 群主点头。
  // ❌ 不带 token：token 只存在于邀请链接里,而这条路的前提就是「没人给过你链接」。
  // ⚠️ 返回恒为 'pending'(除非本来就已是成员)。群号是**连号序列**,直接入群等于谁都能顺着号
  //    把全产品的 open 群刷一遍 —— 所以 RPC 那头对 open 与 approval 一视同仁,只落申请。
  async requestGroupJoinByPublicId(publicId: number, message?: string | null): Promise<JoinGroupByIdOutcome> {
    const id = requirePositivePublicId(publicId)
    const { data, error } = await chatDb.rpc('request_group_join_by_id', {
      p_public_id: id,
      p_message: message?.trim() || null,
    })
    if (error) {
      // 「群主没开自助加入」「该群仅限邀请」「群号不存在」都是**正常结果**,不是故障 ——
      // 抛异常会逼 UI 用 try/catch 走控制流,还容易顺手把 error.message 原样贴给用户。
      // RPC 那头抛的是稳定 ASCII 标识(见迁移 20260906003846),这里翻成可穷举的 reason。
      const reason = JOIN_BY_ID_REFUSALS.find((candidate) => error.message?.includes(candidate))
      if (reason) return { status: 'refused', reason }
      throw new Error(messageForUser(error), { cause: error })
    }
    const status = data === 'joined' ? 'joined' : 'pending'
    const lookup = await this.lookupPublicGroupInvite(id)
    if (!lookup.group) throw new Error('Public group join returned no group')
    return { status, group: lookup.group }
  },

  // @@@1175 — Explore 公开群发现：按 名称/简介/创建者 搜「已公开到广场」的群（search_discoverable_groups RPC，
  // 仅命中 is_discoverable=true → 私有群不泄露）。空 query = 列全部可发现群（广场默认列表）。
  async searchDiscoverableGroups(query: string, limit = 30): Promise<DiscoverableGroup[]> {
    const { data, error } = await chatDb.rpc('search_discoverable_groups', {
      p_query: query ?? '',
      p_limit: limit,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    const rows = (data ?? []) as DiscoverableGroupRpcRow[]
    return rows.map((row) => ({
      id: row.chat_id,
      public_id: row.public_id,
      name: row.name ?? fallbackChatName('group'),
      description: row.description ?? null,
      avatar_url: row.avatar_url ?? null,
      member_count: row.member_count ?? 0,
      is_member: Boolean(row.is_member),
      join_mode: row.join_mode === 'approval' || row.join_mode === 'invite_only' ? row.join_mode : 'open',
      join_request_status:
        row.join_request_status === 'pending' ||
        row.join_request_status === 'accepted' ||
        row.join_request_status === 'rejected'
          ? row.join_request_status
          : null,
      join_token: row.join_token ?? null,
      // @@@1874 — 缺列（迁移未 apply 前的旧 RPC）默认 true = 沿用旧「显示加入」行为，迁移后按真值置灰。
      invite_link_enabled: row.invite_link_enabled ?? true,
      creator_name: row.creator_name ?? null,
      member_avatars: parseGroupAvatarMembers(row.member_avatars),
    }))
  },

  /**
   * #6396 这个账号的「<label> <n>」已经用到几号(identity.agent_name_serials,删掉/改过名的 agent 用过的号也算);
   * 还没用过 = 0。默认起名从它 + 1 开始,序号只增不减。
   */
  async getAgentNameSerialFloor(userId: string, label: string): Promise<number> {
    const { data, error } = await identity()
      .from('agent_name_serials')
      .select('high_water')
      .eq('owner_user_id', userId)
      .eq('base', label)
      .maybeSingle()
    if (error) throw new Error(messageForUser(error), { cause: error })
    return (data as { high_water: number } | null)?.high_water ?? 0
  },

  /** Fetch human friends plus agents owned by the current user. */
  async getContacts(userId: string): Promise<ContactUser[]> {
    const { data: friendships, error: friendshipError } = await identity()
      .from('friendships')
      .select('user_a_id, user_b_id')
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

    if (friendshipError) throw new Error(messageForUser(friendshipError), { cause: friendshipError })

    const friendIds = [
      ...new Set(
        ((friendships ?? []) as { user_a_id: string; user_b_id: string }[])
          .map((f) => (f.user_a_id === userId ? f.user_b_id : f.user_a_id)),
      ),
    ]

    const [friendUsers, agentUsers] = await Promise.all([
      readDisplayIdentities(friendIds),
      readOwnedDisplayIdentities(userId),
    ])

    const usersById = new Map<string, ContactUser>()
    // Legacy Agent-human friendship rows are intentionally not migrated or treated as contacts.
    for (const row of friendUsers as ContactUser[]) if (row.type === 'human') usersById.set(row.id, row)
    for (const row of agentUsers as ContactUser[]) usersById.set(row.id, row)

    const contactIds = [...usersById.keys()]
    if (!contactIds.length) return []
    const contactIdSet = new Set(contactIds)

    // @@@owner-scoped fetch - moves large contact lists out of PostgREST URLs; RLS still bounds this to the current user's aliases.
    const { data: overrides, error: overridesError } = await identity()
      .from('contact_overrides')
      .select('target_id, alias')
      .eq('owner_user_id', userId).eq('target_kind', 'contact')

    if (overridesError) throw new Error(messageForUser(overridesError), { cause: overridesError })

    const aliasById = new Map(
      ((overrides ?? []) as ContactOverrideRow[])
        .filter((row) => contactIdSet.has(row.target_id))
        .map((row) => [row.target_id, row.alias]),
    )

    return enrichAgentMetadata([...usersById.values()].map((user) => ({
      ...user,
      alias: aliasById.get(user.id) ?? null,
    })), userId)
  },

  /** Agents owned by somebody else are contacts only while both sides share an active group. */
  /** Search users or agents by display name (substring), 咕咕号 (gugu_number), or FULL email (exact).
   *  #2038 — enumeration is now blocked at the API: `email` is REVOKE'd from the authenticated
   *  column-grant (can't be select'd OR filtered via PostgREST `?email=ilike.*`), and all three
   *  search keys run server-side in the SECURITY DEFINER RPC `identity.search_users`, which reads
   *  email only to EQUALITY-match a whitelisted full address and never returns it. Substring/wildcard
   *  email probes match nothing (#635 stays enforced); exact-email discovery stays working (#2030). */
  async searchUsers(query: string, currentUserId: string): Promise<ContactUser[]> {
    const q = query.trim()
    if (!q) return []
    // p_query is a bound parameter (not a PostgREST filter), so the `*`→`%` translation that made
    // the old client-side filter dangerous cannot happen; the RPC does its own LIKE escaping.
    const { data, error } = await identityDb.rpc('search_users', { p_query: q })
    if (error) throw new Error(messageForUser(error), { cause: error })
    // The RPC only discovers candidates. The approved adapter owns complete display rows.
    return enrichAgentMetadata(await readRequiredDisplayIdentities((data ?? []).map((row: unknown) => String((row as { id?: unknown }).id ?? ''))), currentUserId)
  },

  async setAgentPublic(agentUserId: string, agentPublic: boolean): Promise<ContactUser> {
    const { data, error } = await identityDb.rpc('set_agent_public', {
      p_agent_user_id: agentUserId,
      p_agent_public: agentPublic,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    return data as ContactUser
  },

  async setAgentDesiredStatus(agentUserId: string, desiredStatus: 'online' | 'offline'): Promise<ContactUser> {
    const { data, error } = await identityDb.rpc('set_agent_desired_status', {
      p_agent_user_id: agentUserId,
      p_desired_status: desiredStatus,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    return data as ContactUser
  },

  async updateContactAlias(userId: string, contactUserId: string, alias: string): Promise<void> {
    try {
      await updateDisplayAlias(userId, { kind: 'contact', id: contactUserId }, alias)
    } catch (error) {
      throw new Error(messageForUser(error), { cause: error })
    }
  },

  async removeContact(contactUserId: string): Promise<void> {
    const { error } = await identityDb.rpc('remove_contact', {
      p_contact_user_id: contactUserId,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
  },

  async removeOwnedAgent(agentUserId: string): Promise<void> {
    try {
      await permanentlyRemove({ client: identityDb, agentId: agentUserId })
    } catch (error) {
      throw new Error(messageForUser(error), { cause: error })
    }
  },

  // #1228: update an owned agent's profile (name + bio) in one write. RLS path:
  // authenticated has COLUMN-level UPDATE on display_name + bio (#78,
  // no RPC/migration). @@@no-updated-at (#78): never set updated_at (no grant → denial).
  // Empty bio → null (clear). display_name omitted = unchanged; empty display_name rejected.
  async updateOwnedAgentProfile(
    agentUserId: string,
    fields: { display_name?: string; bio?: string; avatar?: string | null },
  ): Promise<ContactUser> {
    const payload: { display_name?: string; bio?: string | null; avatar?: string | null } = {}
    const ownerId = await getCurrentAuthUserId()
    let previousAvatar: string | null = null
    let linkedTask = false
    if (fields.avatar !== undefined || fields.display_name !== undefined) {
      const { data: current, error: currentError } = await identity()
        .from('users')
        .select('avatar,name_serial')
        .eq('id', agentUserId)
        .eq('type', 'agent')
        .single()
      if (currentError) throw new Error(messageForUser(currentError), { cause: currentError })
      previousAvatar = (current as { avatar?: string | null }).avatar ?? null
      linkedTask = !isMyAssistant(ownerId, agentUserId) && (current.name_serial != null || Object.values(liveDeviceSessions())
        .some((directory) => directory.sessions.some((session) => session.agent?.userId === agentUserId)))
    }
    if (fields.display_name !== undefined) {
      const display_name = fields.display_name.trim()
      if (!display_name) throw new Error(i18n.t('errors.nameRequired', { ns: 'contacts' }))
      payload.display_name = linkedTask ? taskAgentName(display_name) : display_name
    }
    if (fields.bio !== undefined) {
      const bio = fields.bio.trim()
      payload.bio = bio === '' ? null : bio
    }
    if (fields.avatar !== undefined) payload.avatar = fields.avatar
    const { data, error } = await updateOwnedAgentIdentity(identity(), agentUserId, payload, DISPLAY_IDENTITY_SELECT, ownerId).single()
    if (error) throw new Error(messageForUser(error), { cause: error })
    const updated = data as ContactUser
    const previousPath = managedAgentAvatarPath(previousAvatar)
    const nextPath = managedAgentAvatarPath(updated.avatar)
    if (previousPath && previousPath !== nextPath) {
      const { error: cleanupError } = await dataClient.storage.from('avatars').remove([previousPath])
      if (cleanupError) console.warn('[AgentAvatar] failed to clean up replaced avatar', cleanupError)
    }
    return updated
  },

  /** 形象(颜色 + 休息表情)→ 存进头像字段的那个地址(本套环境存储里那个颜色的定格图 + 表情)。 */
  agentLookAvatarUrl(look: AgentLook): string {
    const { data } = dataClient.storage.from('avatars').getPublicUrl(lookObjectPath(look.color))
    return buildLookUrl(data.publicUrl, look.rest, look.wear)
  },


  async uploadOwnedAgentAvatar(
    agentUserId: string,
    file: File,
    profile: { display_name?: string; bio?: string } = {},
  ): Promise<ContactUser> {
    const validationError = validateAgentAvatarFile(file)
    if (validationError) throw new Error(validationError)
    const ownerId = await getCurrentAuthUserId()
    const path = agentAvatarStoragePath(ownerId, agentUserId, file.type, crypto.randomUUID())
    const { error: uploadError } = await dataClient.storage.from('avatars').upload(path, file, {
      upsert: false,
      contentType: file.type,
      cacheControl: '3600',
    })
    if (uploadError) throw new Error(messageForUser(uploadError), { cause: uploadError })

    const { data: publicData } = dataClient.storage.from('avatars').getPublicUrl(path)
    try {
      const updated = await contactsService.updateOwnedAgentProfile(agentUserId, {
        ...profile,
        avatar: publicData.publicUrl,
      })
      return updated
    } catch (error) {
      const { error: cleanupError } = await dataClient.storage.from('avatars').remove([path])
      if (cleanupError) {
        throw new Error(String((error as Error)?.message ?? error), { cause: { profileError: error, cleanupError } })
      }
      throw error
    }
  },

  async getContactGroups(userId: string): Promise<ContactGroup[]> {
    const [{ data: groups, error: groupsError }, { data: members, error: membersError }] = await Promise.all([
      identity()
        .from('contact_groups')
        .select('id, owner_user_id, name, sort_order, created_at, updated_at')
        .eq('owner_user_id', userId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      identity()
        .from('contact_group_members')
        .select('group_id, contact_user_id'),
    ])

    if (groupsError) throw new Error(messageForUser(groupsError), { cause: groupsError })
    if (membersError) throw new Error(messageForUser(membersError), { cause: membersError })

    const memberMap = new Map<string, string[]>()
    for (const row of (members ?? []) as ContactGroupMemberRow[]) {
      const ids = memberMap.get(row.group_id) ?? []
      ids.push(row.contact_user_id)
      memberMap.set(row.group_id, ids)
    }

    return ((groups ?? []) as ContactGroupRow[]).map((group) => ({
      ...group,
      contactIds: memberMap.get(group.id) ?? [],
    }))
  },

  async createContactGroup(userId: string, name: string): Promise<ContactGroup> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const { data, error } = await identity()
      .from('contact_groups')
      .insert(dbPayload<ContactGroupInsert>({
        id,
        owner_user_id: userId,
        name: name.trim(),
        sort_order: 0,
        created_at: now,
        updated_at: now,
      }))
      .select('id, owner_user_id, name, sort_order, created_at, updated_at')
      .single()

    if (error) throw new Error(messageForUser(error), { cause: error })
    const row = data as ContactGroupRow
    return { ...row, contactIds: [] }
  },

  async renameContactGroup(groupId: string, name: string): Promise<void> {
    const { error } = await identity()
      .from('contact_groups')
      .update(dbPayload<ContactGroupPatch>({ name: name.trim(), updated_at: new Date().toISOString() }))
      .eq('id', groupId)

    if (error) throw new Error(messageForUser(error), { cause: error })
  },

  async deleteContactGroup(groupId: string): Promise<void> {
    const { error } = await identity()
      .from('contact_groups')
      .delete()
      .eq('id', groupId)

    if (error) throw new Error(messageForUser(error), { cause: error })
  },

  async updateContactGroupMembers(groupId: string, contactIds: string[]): Promise<void> {
    const nextIds = new Set(contactIds)
    const { data: existingRows, error: existingError } = await identity()
      .from('contact_group_members')
      .select('contact_user_id')
      .eq('group_id', groupId)

    if (existingError) throw new Error(messageForUser(existingError), { cause: existingError })

    const existingIds = new Set(
      ((existingRows ?? []) as { contact_user_id: string }[]).map((row) => row.contact_user_id),
    )
    const removedIds = [...existingIds].filter((id) => !nextIds.has(id))
    const addedIds = [...nextIds].filter((id) => !existingIds.has(id))

    if (removedIds.length > 0) {
      const { error: deleteError } = await identity()
        .from('contact_group_members')
        .delete()
        .eq('group_id', groupId)
        .in('contact_user_id', removedIds)

      if (deleteError) throw new Error(messageForUser(deleteError), { cause: deleteError })
    }

    if (addedIds.length === 0) return

    const rows = addedIds.map((contactUserId) => ({
      group_id: groupId,
      contact_user_id: contactUserId,
    }))
    const { error: insertError } = await identity()
      .from('contact_group_members')
      .insert(dbPayload<ContactGroupMemberInsert[]>(rows))

    if (insertError) throw new Error(messageForUser(insertError), { cause: insertError })
  },

  async getCommonGroupChats(userId: string, contactUserId: string): Promise<ContactGroupChat[]> {
    const { data: myRows, error: myError } = await chat()
      .from('chat_members')
      .select('chat_id, notification_level')
      .eq('user_id', userId)

    if (myError) throw new Error(messageForUser(myError), { cause: myError })
    const myMemberMap = new Map(((myRows ?? []) as ChatMemberMuteRow[]).map((row) => [row.chat_id, row]))
    const myChatIds = [...new Set(((myRows ?? []) as ChatMemberMuteRow[]).map((row) => row.chat_id))]
    if (myChatIds.length === 0) return []

    // @@@1752 — chunked like #1666: my chat id list is unbounded (grows with group count).
    const peerRows = await fetchInChunks(myChatIds, async (chunk) => {
      const { data, error } = await chat()
        .from('chat_members')
        .select('chat_id')
        .eq('user_id', contactUserId)
        .in('chat_id', chunk)
      if (error) throw new Error(messageForUser(error), { cause: error })
      return (data as { chat_id: string }[] | null) ?? []
    })
    const commonIds = [...new Set(peerRows.map((row) => row.chat_id))]
    if (commonIds.length === 0) return []

    const groupRows = await fetchActiveGroupChats(commonIds)
    const groupIds = groupRows.map((row) => row.id)
    const mutedByChat = new Map(groupIds.map((groupId) => [groupId, requireChatMemberMuted(myMemberMap, groupId)]))
    const members = await loadChatMemberIds(groupIds)

    return groupRows.map((row) => ({
      id: row.id,
      public_id: row.public_id,
      kind: row.kind,
      name: row.name ?? fallbackChatName(row.kind),
      avatar_url: row.avatar_url ?? null,
      member_count: requireChatMemberCount(members, row.id),
      is_muted: mutedByChat.get(row.id) ?? requireChatMemberMuted(myMemberMap, row.id),
      member_user_ids: members.get(row.id) ?? [],
    }))
  },

  /** Send a friend request. */
  async sendRequest(senderId: string, receiverId: string, message?: string | null): Promise<void> {
    const trimmed = message?.trim()
    const { error } = await identityDb.from('friend_requests').insert(dbPayload<FriendRequestInsert>({
      sender_id: senderId,
      receiver_id: receiverId,
      message: trimmed ? trimmed : null,
    }))
    if (error) {
      // #1795 — 唯一违反（唯一性已收窄到 status='pending'）此时只可能是「同方向已有待处理申请」，
      // 给用户人话；其余错误原文进 console（开发者可查），用户不看 driver 原始字符串。
      if (error.code === '23505') throw new Error(i18n.t('errors.friendRequestPending', { ns: 'contacts' }))
      console.error('[contacts] sendRequest failed', error)
      throw new Error(messageForUser(error), { cause: error })
    }
  },

  /** Accept a received friend request (calls server-side RPC). */
  async acceptRequest(requestId: string): Promise<AcceptFriendRequestResult> {
    const { data, error } = await identityDb.rpc('accept_friend_request_by_id', {
      p_request_id: requestId,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
    return await normalizeAcceptFriendRequestResult(data as AcceptFriendRequestRow[] | AcceptFriendRequestRow | null)
  },

  /** Reject a received friend request. */
  async rejectRequest(requestId: string): Promise<void> {
    const { error } = await identityDb.rpc('reject_friend_request_by_id', {
      p_request_id: requestId,
    })
    if (error) throw new Error(messageForUser(error), { cause: error })
  },

  /** Fetch incoming requests to me and my agents, every status (「新的请求」lists the history). */
  async getReceivedRequests(userId: string): Promise<FriendRequest[]> {
    const agentRows = await readOwnedDisplayIdentities(userId)
    const receiverIds = [
      userId,
      ...agentRows.map((row) => row.id),
    ]

    // @@@1752 — chunked like #1666（receiver 列表随自有 agent 数无界）。原语义 fail-soft（error 被忽略
    // → 整体空列表），分批版保持 all-or-nothing：任一 chunk 失败 → 整体 []（不产出部分列表冒充全量）。
    type PendingRequestRow = {
      id: string
      sender_id: string
      receiver_id: string
      message: string | null
      status: FriendRequestStatus
      created_at: string
    }
    const rows = await fetchInChunks(receiverIds, async (chunk) => {
      const select = () => identityDb.from('friend_requests').select(FRIEND_REQUEST_SELECT).in('receiver_id', chunk)
      const [pending, decided] = await Promise.all([select().eq('status', 'pending'), select().neq('status', 'pending').order('created_at', { ascending: false }).limit(FRIEND_REQUEST_HISTORY_LIMIT)])
      const error = pending.error ?? decided.error
      if (error) throw new Error(messageForUser(error), { cause: error })
      return [...(pending.data ?? []), ...(decided.data ?? [])] as PendingRequestRow[]
    }).catch(() => [] as PendingRequestRow[])
    rows.sort((a, b) => compareIsoDescNullsLast(a.created_at, b.created_at))

    if (!rows.length) return []

    return rows
  },

  /** Fetch requests I sent, every status (等待验证 / 已添加 / 未通过). */
  async getSentRequests(userId: string): Promise<FriendRequest[]> {
    const select = () => identityDb.from('friend_requests').select(FRIEND_REQUEST_SELECT).eq('sender_id', userId)
    const [pending, decided] = await Promise.all([select().eq('status', 'pending'), select().neq('status', 'pending').order('created_at', { ascending: false }).limit(FRIEND_REQUEST_HISTORY_LIMIT)])
    const error = pending.error ?? decided.error
    if (error) throw new Error(messageForUser(error), { cause: error })
    const data = [...(pending.data ?? []), ...(decided.data ?? [])]
    if (!data.length) return []

    const rows = data as {
      id: string
      sender_id: string
      receiver_id: string
      message: string | null
      status: FriendRequestStatus
      created_at: string
    }[]

    return rows
  },

}
