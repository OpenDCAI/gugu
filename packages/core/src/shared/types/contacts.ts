import type { AgentDesiredStatus, AgentType, ChatStatus, GroupAvatarMember, GroupJoinMode, GroupMemberRole } from './chat'

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected'

export interface ContactUser {
  id: string
  gugu_number?: number | null
  name_serial?: number | null
  display_name: string
  avatar: string | null
  // @@@no-peer-email (#635) - email is never fetched for peers (PII; see contacts CONTACT_USER_SELECT).
  // Absent on every contact model; own email comes from the auth session, not this type.
  email?: string | null
  bio: string | null
  type?: 'human' | 'agent'
  alias?: string | null
  owner_user_id?: string | null
  agent_public?: boolean | null
  desired_status?: AgentDesiredStatus | null
  session_archived_at?: string | null
  session_lifecycle_revision?: number
  created_at?: string | null
  updated_at?: string | null
  // @@@1289 含 'gugu-cloud'（云 agent 固定标记）+ 六款 CLI engine —— AgentType 已涵盖；UI 显示为「云端 Agent」。
  agent_type?: AgentType | null
  // @@@1761 'cloud:' 前缀 = 云 agent 运行时标记（isCloudAgentMarked 判定用；agent_type 只富化自有 agent）
  device_id?: string | null
  project_path?: string | null
}

export interface FriendRequest {
  id: string
  sender_id: string
  receiver_id: string
  sender?: ContactUser
  receiver?: ContactUser
  message: string | null
  status: FriendRequestStatus
  created_at: string
}

export interface AcceptFriendRequestResult {
  chatId: string | null
  name: string | null
  kind: 'group' | null
  created: boolean
  member_count: number | null
}

export interface ContactGroup {
  id: string
  owner_user_id: string
  name: string
  sort_order: number
  contactIds: string[]
  created_at: string
  updated_at: string
}

export interface ContactGroupChat {
  id: string
  public_id?: number | null
  kind: 'group'
  name: string
  alias?: string | null
  avatar_url: string | null
  status?: ChatStatus
  group_prompt?: string | null
  default_agent_type?: AgentType | null
  member_count: number
  is_muted: boolean
  // @@@1694 当前用户在该群的角色（owner/admin/member）——通讯录群行右键菜单角色化「退出群聊/解散群聊」用。
  // 来自会话投影的 chat_members.role；未取到为 null（如 getCommonGroupChats 不填）。
  my_role?: GroupMemberRole | null
  member_user_ids?: string[]
}

export interface PublicGroupInviteGroup {
  id: string
  public_id: number
  kind: 'group'
  name: string
  member_count: number
  is_member: boolean
  is_muted: boolean | null
  // @@@group-join-mode (#1018 step3 #858) — open(直接加入) / approval(需审批) / invite_only(仅邀请)。
  join_mode: GroupJoinMode
  // 本人对该群的待决请求状态（null=无请求；pending=已申请待审批；rejected=被拒）。
  join_request_status: 'pending' | 'accepted' | 'rejected' | null
}

export interface PublicGroupInviteLookupResult {
  status: 'joined' | 'available' | 'not_found' | 'lookup_error'
  group: PublicGroupInviteGroup | null
}

// @@@direct-join (#653) - open 群扫码直接入群；#858 起 approval 群扫码改为提交加入请求。
export interface PublicGroupJoinResult {
  status: 'joined' | 'pending'
  group: PublicGroupInviteGroup
}

// @@@1175 — Explore 公开群发现结果行（search_discoverable_groups RPC）。仅命中 is_discoverable=true 的群。
// join_token 随结果返回（对 opt-in 公开群不再是防枚举秘密），前端凭它走现成 requestGroupJoin（open→入群 / approval→申请）。
export interface DiscoverableGroup {
  id: string
  public_id: number
  name: string
  description: string | null
  avatar_url: string | null
  member_count: number
  is_member: boolean
  join_mode: GroupJoinMode
  join_request_status: 'pending' | 'accepted' | 'rejected' | null
  join_token: string | null
  // @@@1874 — 群「邀请链接」开关。false = 链接关，凭 token 的入群会被 RPC 以「邀请链接已关闭」拒；
  // 前端据此把该群「加入」置灰 + 给行级说明，不呈现注定失败的可点按钮。
  invite_link_enabled: boolean
  creator_name: string | null
  // @@@group-avatar-tile — 群头像组合的成员格（最多 9，与组合布局上限同）。广场行与聊天列表/通讯录
  // 走同一条群头像链路：avatar_url 为 NULL 时用它组合出群的脸。非成员读不到 chat_members，
  // 故由 search_discoverable_groups(SECURITY DEFINER) 随结果带出。
  member_avatars: GroupAvatarMember[]
}
