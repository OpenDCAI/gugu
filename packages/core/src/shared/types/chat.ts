import type { DeviceActionsSummary } from '../deviceActions'
import type { AgentType } from '@gugu/core/agentTypes'
import type { AgentStatusView } from '../agentStatus'
import type { CloudComputerPresence, DeviceHostInfo } from './deviceHost'
import type { DeviceProject } from './deviceProject'
import type { AgentFailureReason } from '../agentQuotaReason'
import type { FileMetadata } from '../fileResolver'
export type { AgentType } from '@gugu/core/agentTypes'

// @@@1514 channel 概念已抹除(collapse 进 group)：公开 agent 好友会话原是独立 'channel' kind，
// 因其本就多成员 + owner/admin/member 角色 + 共用 group_agent_states(结构即 group)而并入 group。
// 'ai' = 本机自己的 agent 1:1 会话，与 channel 无关，保留。
// @@@5856 'topic' = 话题：从一条已有消息长出来的独立工作线，有自己的成员名单（product spec）。
// 它在会话列表里**缩进挂在来源那条线底下**，❌ 不占一行平级的会话——source_chat_id 既是溯源指针也是归属。
export type ChatKind = 'dm' | 'group' | 'ai' | 'topic'
export type ChatStatus = 'active' | 'stopped' | 'paused' | 'archived'
export type MessageContentType = 'text' | 'card' | 'system' | 'attachment' | 'widget'
export type MessageDeliveryStatus = 'delivered' | 'read'
export type GroupMemberType = 'human' | 'agent'
export type NotificationLevel = 'all' | 'important' | 'none'

// @@@group-avatar-tile — 群头像组合的一格。产品对「群的脸」只有一个定义：显式群头像原样投影，
// 从未设过则由成员组合表达（presets 不变量）。每格必须带**稳定 id**——它既是 key 也是该成员没上传
// 头像时生成默认脸的 seed；姓名永不当 seed。所有渲染群头像的 surface 都喂这一种结构。
export type GroupAvatarMember = {
  id: string
  name: string
  avatar: string | null
}

export type ChatUnreadLocator = {
  stream_id: string
  stream_kind: 'main' | 'thread'
  thread_root_id: string | null
  message_id: string | null
  message_seq: number | null
  unread_count: number
  /**
   * 未读里叫到你的条数:点名你、@all,或回复你说的那条(服务端 list_unread_locators.addressed_count)。手动标未读算 1。
   * 必有:缺这一列是协议错误(chatProjection 读到就抛);本机缓存里缺它的行按无效缓存重建(localSyncDb)。
   */
  addressed_count: number
  cursor_seq: number
  version: number
  is_marked_unread: boolean
}

export interface ChatItem {
  id: string
  public_id?: number | null
  kind: ChatKind
  status: ChatStatus
  peer_user_id?: string | null
  peer_alias?: string | null
  /** Private group display name owned by the signed-in account. */
  alias?: string | null
  avatar?: string | null
  member_user_ids?: string[]
  name: string
  // @@@2264 会话排序的 canonical activity 投影底座:无消息的会话以创建时刻参与排序(chatActivityAt),
  // 必填 —— 每个构造点都得给出,排序键永不缺失。
  created_at: string
  last_message_at: string | null
  last_message_preview: string | null
  /** The last message is an agent's failure row: the list says this reason in the viewer's language, not the preview. */
  last_message_failure?: AgentFailureReason | null
  unread_count: number
  /** The server-owned stream/message locator for the first unread projection. */
  unread_locator?: ChatUnreadLocator | null
  pinned_message_id: string | null
  last_read_seq: number
  /** Durable manual-unread bit from this member's read-state row. */
  is_marked_unread?: boolean
  /** Monotonic version selecting the whole {cursor, manual mark, unread projection} tuple. */
  read_state_version?: number
  member_updated_at?: string | null
  next_message_seq: number
  is_pinned?: boolean
  is_muted?: boolean
  notification_level?: NotificationLevel
  /** 我在这条线里的角色(chat_members.role);只有投影装配的群 / 话题行带它。 */
  my_role?: GroupMemberRole | null
  // @@@5856 话题的溯源指针（仅 kind==='topic' 非空）。可见性继承 source_chat_id 那条线；
  // source_message_id 指向它所从出的那条消息（面包屑与锚点卡双向连接靠这一对）。
  source_chat_id?: string | null
  source_message_id?: string | null
}

// @@@5856 一条线上长出来的话题（chat.list_topics_of_chat 的行）。锚点卡与话题清单共用。
// is_participant 把「可见」和「参与」分开说清：能看见不等于会被通知。
export interface TopicSummary {
  chat_id: string
  name: string
  source_message_id: string
  creator_user_id: string | null
  last_message_at: string | null
  message_count: number
  participant_count: number
  is_participant: boolean
}

export interface MessageItem {
  id: string
  chat_id: string
  // @@@2051 注销用户:被删用户的消息 sender 经 ON DELETE SET NULL 变 null(内容存活、作者匿名为「已注销用户」)。
  sender_user_id: string | null
  to_user_ids: string[] | null
  // @@@whisper (#820) - true = 定向私密消息（仅 sender + to_user_ids 可见，RLS 强制）；与「@提及定向(公开)」区分。
  is_whisper?: boolean
  // App 用 gugu.dispatch 以人的名义发的那一行:App 的 id(= manifest id);其余 null(#6835)。
  via_app?: string | null
  /** Public AI-sent marker; the source identity is visible only to the human sender. */
  sent_by_agent?: boolean
  agent_sender?: { id: string | null; name: string } | null
  /** #7290 附件消息指向群文件夹的条目与版本(新式附件;老式的字节在正文的 [URL] 里)。条目删了 ⇒ item 为 null、正文还在。 */
  file_item_id?: string | null
  file_version?: number | null
  /** #7290 悄悄话的附件:不进群文件夹,直接指字节;能读这条消息的人才签得到链接。 */
  file_blob_id?: string | null
  /** Authorized pinned-file display metadata; original reads still use the file resolver. */
  file_metadata?: FileMetadata | null
  /** Local sending preview only; committed dimensions come from the verified file metadata. */
  image_dimensions?: { width: number; height: number }
  seq: number
  content: string | null
  content_type: MessageContentType
  reply_to_message_id: string | null
  reply_to_sender_user_id?: string | null
  reply_to_content?: string | null
  retracted_at: string | null
  created_at: string
  reactions: ReactionGroup[]
  is_mine: boolean
  delivered: boolean
  delivery_status: MessageDeliveryStatus | null
  // @@@per-message-read (#598) - user_ids of recipients that have read THIS message (from message_deliveries
  // 'read' rows), independent of the monotonic last_read_seq watermark. Drives precise directed read receipts.
  readers?: string[]
  delivery_blocks?: Array<{ agent_user_id: string; reason: 'agent_archived' }>
  local_send_state?: 'sending' | 'failed' | 'unknown' | null
  local_send_error?: string | null
  forwarded_from_message_id?: string | null
  // @@@threads (#957) — 非空 = 此消息是某话题(thread_root_id 指向的 root)下的回复；
  // 主时间线过滤掉这些(不刷屏主线)、thread 视图按 root 聚合。root 消息本身 thread_root_id 为 null。
  thread_root_id?: string | null
  // @@@threads (#1196 Q2) — true = 此主线消息是话题根(开 thread 即标，ruling A)；
  is_thread_root?: boolean
  /** Stable producer id. Imported-history roots use an exact session-import-root:<uuid> marker. */
  client_message_id?: string | null
  // @@@message-edit — 非空 = 消息已被编辑(渲染「已编辑」指示)。
  edited_at?: string | null
}

/** queued = persisted, but an agent it wakes has not taken it yet (shared/ui/systemNotice.ts queuedMessageIds). */
export type MessageSendState = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown'

export interface ReactionGroup {
  emoji: string
  count: number
  my_reaction: boolean
}

export type GroupTaskStatus = 'proposal' | 'todo' | 'running' | 'review' | 'done' | 'cancelled'
export type GroupTaskPriority = 'P1' | 'P2' | 'P3'
export type AgentAccountStatus = 'active' | 'removed'
export type AgentDesiredStatus = 'online' | 'offline'
export type AgentRuntimeStatus = 'starting' | 'online' | 'offline'
export type AgentActivityStatus = 'idle' | 'running'
/**
 * 聊天侧一个 agent 的粗分类(头像动效、群汇总排序、运行条、composer 忙态按它决定):读数的四个基础状态
 * (idle / working / needs_user / error,working 里再分出静止的 parked),加上不可达的 offline / removed 与首次快照前的
 * pending(spec agent-status)。「进程在不在内存」不让用户感知:没有活 runtime 但可达 = idle,会话正在起 = working。
 * 它是 `presentAgentStatus` 的输出折出来的(`displayStatusOf`),❌ 另有推导;文案与颜色读完整的 presentation。
 */
export type AgentDisplayStatus = 'pending' | 'idle' | 'working' | 'parked' | 'needs_user' | 'offline' | 'archived' | 'removed' | 'error'
export type AgentConversationActivityStatus =
  | Extract<AgentRuntimeStatus, 'starting'>
  | AgentActivityStatus
export type GroupMemberRole = 'owner' | 'admin' | 'member'
export type GroupMemberRoleInput = GroupMemberRole
export type DeviceStatus = 'online' | 'offline'

export interface GroupSchedulerState {
  chat_id: string
  paused: boolean
  queue_count: number
  blocked_count: number
  summary: string | null
  updated_at: string
}

export interface GroupMemberItem {
  id: string
  role: GroupMemberRole
  type: GroupMemberType
  account_status: AgentAccountStatus | null
}

export interface GroupChatSettings {
  my_role: GroupMemberRole | null
  can_manage: boolean
  can_dissolve: boolean
  can_archive_topic: boolean
  id: string
  public_id?: number | null
  creator_user_id: string | null
  name: string
  status: ChatStatus
  group_prompt: string | null
  default_agent_type: AgentType | null
  // @@@group-join-token (#653) - the group's invite secret, used to build the join QR. Member-only
  // (chats SELECT RLS = chat.is_member), so returning it here doesn't leak to non-members.
  join_token?: string | null
  // @@@group-settings-base (#1018 step1) — 群设置基础字段
  description: string | null
  max_members: number
  allow_member_invite: boolean
  // @@@invite-link-toggle (#851) — when false, token-bearing invite links/QR cannot join this group.
  invite_link_enabled: boolean
  agent_join_approval: boolean
  // @@@group-join-mode (#1018 step3 #858) — open(直接加入) / approval(需审批) / invite_only(仅邀请)
  join_mode: GroupJoinMode
  // @@@hide-history (#1018 step4 #860) — 开启后仅对此后入群者隐藏加入前历史（future-only）
  hide_history: boolean
  // @@@group-avatar (#1164 G1) — 群头像公共 URL（chats.avatar_url）；null = 未设，回落首字母占位。
  avatar_url: string | null
  // @@@1175 — 群主 opt-in「公开到广场」：true 才进 Explore 公开群发现（按名称/简介/创建者可被搜到）。默认 false=私有。
  is_discoverable: boolean
  // @@@5856 「agent 超过几个就全员转为点名才回」。null = 继承（话题跟来源那条线，群跟产品默认）。
  agent_flood_threshold: number | null
  // 继承之后**实际生效**的那个数，由 DB 计算列给出（chat.agent_flood_threshold_effective）。
  // ❌ 客户端不许自己再写一遍 COALESCE —— 那就是第二份会跟触发器分叉的真相。
  agent_flood_threshold_effective: number | null
}

// @@@group-join-mode (#1018 step3 #858)
export type GroupJoinMode = 'open' | 'approval' | 'invite_only'

// 待审批的加入请求（#858 审批队列）。列表经 list_group_join_requests RPC（仅管理员可见）。
export interface GroupJoinRequest {
  id: string
  chat_id: string
  /** 要进群的那个身份:人类自助申请时是他本人;「Agent 加入需审批」时是那个 agent。 */
  requester_user_id: string
  requester_type: 'human' | 'agent'
  /** 替 agent 发起的人;人类自助申请时为 null。 */
  requested_by_user_id: string | null
  message: string | null
  status: 'pending' | 'accepted' | 'rejected'
  created_at: string | null
}

export interface UpdateGroupChatSettingsInput {
  name?: string
  status?: ChatStatus
  group_prompt?: string | null
  default_agent_type?: AgentType | null
  description?: string | null
  max_members?: number
  allow_member_invite?: boolean
  invite_link_enabled?: boolean
  agent_join_approval?: boolean
  join_mode?: GroupJoinMode
  // @@@hide-history (#1018 step4 #860) — 切换 future-only 历史门控
  hide_history?: boolean
  // @@@1175 — 切换「公开到广场」（Explore 公开群发现 opt-in）
  is_discoverable?: boolean
  // @@@5856 改这条线自己的 agent 数量线；null = 交回去继承。DB 触发器会当场按新线过一遍。
  agent_flood_threshold?: number | null
}

export interface GroupAgentAccount {
  id: string
  gugu_number?: number | null
  display_name: string
  avatar: string | null
  email: string | null
  created_at: string | null
}

export interface Device {
  device_id: string
  label: string
  hostname: string
  platform: string
  status: DeviceStatus
  last_seen_at: string
  /** When the row first appeared: a reinstall or a new data directory is a new row, created later. */
  created_at?: string
  is_online: boolean
  is_current_device?: boolean
  /**
   * 物理机器标识(identity.gugu_devices.machine_id)。设备 id 按(机器, 账号, tier)派生(#523),同一台电脑上
   * 两个 build 是两条设备行;通讯录等「按电脑归类」的展示要拿这一列归并,❌ 把一台电脑显示成两台。
   */
  machine_id?: string | null
  /** Registered build/configuration name; absent on older cached rows. */
  tier?: string
  capabilities: DeviceCapabilities
  /**
   * 这台机器上会话的**状态摘要**（identity.gugu_devices.session_digest，随心跳写）。
   *
   * 只为一件事存在：机器**离线**时，手机仍要看得到「这台机器上有哪些会话、它们卡在哪儿」
   * （product spec 的验收）。会话页的会话是纯本地的，机器一离线就问不到了。
   * 机器在线时 ❌ 不读它 —— 那时有实时的那一份，读这个只会显示成旧的。
   */
  session_digest?: DeviceSessionSummary[]
  /**
   * #113 账号上记着的这台机器上的项目与文件夹(identity.device_projects,那台机器自己写)。这台机器离线时,
   * 各端照这一份列它的项目与文件夹。缺席 = 这一端还没读到过账号上的那份(由用到的地方说「读不到」);
   * 读到了而那台机器没记过项目 = 空列表。
   */
  projects?: DeviceProject[]
  /**
   * #7199 这一行是这个账号的云电脑时,它此刻的样子(休眠中 / 正在唤醒 / 运行中)。库里没有这一列:客户端按云电脑管家
   * 的 /state 补上(管家给的 deviceId 认是哪一行)。睡着时 `is_online` 照实为 false,但 ❌ 按离线处理 —— 见
   * `deviceAcceptsWork`。不是云电脑 = 缺席。
   */
  cloud_computer?: CloudComputerPresence
}

/** 摘要里的一条会话。只有状态，没有正文 —— 「内容不在手机落库」那条边界没有放开。 */
export interface DeviceSessionSummary {
  nativeInputVersion?: 1
  runtime?: 'acp' | 'pty' | 'unknown'
  conversationId: string
  projectId: string
  projectName: string
  title: string
  harness: string
  /** 老宿主写的状态词(可能是旧词 `needs_approval`);新宿主另带 `status`。 */
  agentStatus: string | null
  /** 读数(spec agent-status-vocabulary)。缺席 = 老宿主写的摘要,退回读 `agentStatus`。 */
  status?: AgentStatusView | null
  lastInteractedAt: string | null
  supported: boolean
  /**
   * 以下三项 2026-09-06 才加进摘要（#5013）。**老宿主写的摘要里没有**，
   * 所以一律可选：缺席 = 那台机器的版本还不报这件事，不是「false」。
   * 手机端见到 undefined 画中性态，❌ 不补默认值冒充事实。
   */
  isPinned?: boolean
  unseen?: boolean
  parentConversationId?: string | null
  /**
   * 这条会话的 agent(`identity.users.id`,不带 `user:` 前缀;没有身份 = null)。#7199 才加:机器离线时
   * 任务区也要认得出哪条是个人助理自己的(它不进任务区)。缺席 = 老宿主不报,❌ 当成「没有 agent」。
   */
  agentUserId?: string | null
}

// #6264 设置 → 设备每一行的「这是台什么机器」(心跳随行报的那几项,见 deviceHost.ts);老宿主不报 = 不知道,❌ 补默认值。
export interface DeviceCapabilities extends Partial<DeviceHostInfo> {
  terminals: string[]
  runtimes: string[]
  // @@@host-runtime-capability (#647) - host gugu runtime level; absent/0 = old host predating the field.
  host_runtime_capability?: number
  // @@@fleet-version (#663) - build version of the app reporting the heartbeat; absent = host predating
  // the field (UI shows 版本未知, never fabricates one).
  app_version?: string
  /** Published desktop builds only; development versions never select a cloud host package. */
  published_desktop_version?: string
  /** #7199 这台设备能被调用的动作(设备心跳登记;老设备缺席)。 */
  actions?: DeviceActionsSummary
}

export type GuguSettingsScope = 'user' | `device:${string}` | `chat:${string}`

export interface GuguSettingsRow {
  scope: GuguSettingsScope
  config: Record<string, unknown>
  updated_at: string
}

export type DeviceCommandStatus = 'pending' | 'running' | 'done' | 'error'

export interface DeviceCommand {
  id: string
  status: DeviceCommandStatus
  result: unknown | null
  error: string | null
}

export interface CreateAgentOnDeviceResult {
  agent: GroupAgentAccount
  commandId: string
  chatId: string
}

export type AgentRuntimeType = 'terminal' | 'powershell'

export interface CreateAgentOptions {
  /** Death-bind: every agent is created on exactly one device. */
  deviceId: string
  agentType?: AgentType
  projectPath?: string
  avatar?: string
  runtimeType?: AgentRuntimeType
  // @@@1390 继承记忆开关（DB 落库；runtime 真用待记忆机制，见迁移注释）。缺省 true。
  inheritMemory?: boolean
  // @@@1390 具体目标 Special Focus：注入 agent bootstrap 作"它是谁/做什么"指示 + DB 落库。
  specialFocus?: string
  // 新 agent 选继承哪份全局记忆；来源仅限 Claude Code / Codex 本机 memory。
  memorySources?: ('claude-code' | 'codex')[]
  // 已读出的 owner 本机 memory 内容（按来源键），随创建命令交给目标设备。
  memoryContent?: Record<string, string>
}

export interface AgentConversationActivity {
  agentId: string
  chatId: string
  // @@@1196-q5 thread-scoped running：该「运行中」活动属于哪个 thread（null=主会话）。指示按
  // (chat, thread) 隔离,避免某 thread 跑 turn 让主视图/别的 thread 误亮（修 #957 会话级外溢）。
  threadRootId: string | null
  displayName: string
  avatar: string | null
  startedAt: string
  status: AgentConversationActivityStatus
}

// #857 per-agent Listen Mode。@@@5856 owner 2026-09-19 把三档收成**两档**:
//   passive = 只被 @ / reply 这类结构化点名硬触发;
//   active  = 不点名的场所消息也叫得醒它,回不回由它自己判断。
// 收掉的是老的 adaptive/active 之分 —— 实测两者在投递层、运行时都走同一条路,
// 差别只在提示词,于是三个按钮里有两个表示同一件事。留下的行为是老 adaptive 的,名字叫 active。
// ❌ 不要再加第三档:再加之前先说得出它与这两档在**行为**上的区别。
export type ListenMode = 'passive' | 'active'
export const LISTEN_MODES: ListenMode[] = ['passive', 'active']
export function isListenMode(v: unknown): v is ListenMode {
  return v === 'passive' || v === 'active'
}

export interface GroupAgentItem extends GroupMemberItem {
  client: string | null
  model_source: string | null
  tools: string[]
  permission_scope: string | null
  current_task_id: string | null
  current_task_title: string | null
  last_action: string | null
  last_active_at: string | null
  // #857 Listen Mode：默认 active（新成员），存量 passive。
  listen_mode: ListenMode
}

export interface GroupTaskItem {
  id: string
  chat_id: string
  title: string
  status: GroupTaskStatus
  owner_agent_user_id: string | null
  reviewer_agent_user_id: string | null
  priority: GroupTaskPriority
  progress: number
  last_scheduler_summary: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface GroupOutputItem {
  id: string
  chat_id: string
  task_id: string | null
  name: string
  file_type: string | null
  asset_id: string | null
  url: string | null
  produced_by_user_id: string | null
  size_label: string | null
  created_at: string
}

export interface GroupCollabSnapshot {
  scheduler: GroupSchedulerState
  humans: GroupMemberItem[]
  agents: GroupAgentItem[]
  tasks: GroupTaskItem[]
  outputs: GroupOutputItem[]
}

// @@@group-announcements (#986) — 群公告 posted by owner/admin in a group chat.
export interface GroupAnnouncement {
  id: string
  chatId: string
  authorId: string
  content: string
  pinned: boolean
  createdAt: string // ISO timestamp
  // @@@announcement-likes (#1115) — 点赞计数 + 当前用户是否已赞（chat.group_announcement_likes）。
  likeCount: number
  likedByMe: boolean
}
