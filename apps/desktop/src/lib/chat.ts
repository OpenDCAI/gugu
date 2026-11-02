import { dbPayload } from '@gugu/core/cloud/supabase'
import { createGroupWithInvitations } from '@gugu/core/cloud/groupChat'
import {
  getDeviceCommand as getCoreDeviceCommand,
  pollDeviceCommandUntilDone,
  type DeviceCommandTableClient
} from '@gugu/core/cloud/deviceCommands'
import {
  listDevices as listCoreDevices,
  renameDevice as renameCoreDevice,
  removeDevice as removeCoreDevice,
  type DeviceTableClient,
  type DeviceRpcClient,
} from '@gugu/core/cloud/devices'
import { markLocalDevice } from './device-labels'
import {
  dataClient,
  chatDb,
  identityDb,
  getCurrentAuthUserId
} from './supabase'
import {
  parseAttachmentContent, type AttachmentKind, type AttachmentSource
} from '@gugu/core/shared/ui/attachmentModels'
import { messageItemFromRow, MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { readDeviceDisplayIdentities, readDisplayIdentities } from './identityReadAdapter'
import type { DisplayIdentity } from './displayIdentity'
import { markMemberUnread } from './chatMemberReadState'
import { i18n } from '@/i18n'
import { platform } from '../platform'
import {
  normalizeGroupRole
} from '@gugu/core/shared/enums/groupRoleModels'
import { DEFAULT_AGENT_TYPE, nullableAgentType } from '@gugu/core/shared/enums/agentTypeModels'
import {
  normalizeAgentDisplayName,
  normalizeAgentProjectPath
} from '@gugu/core/shared/ui/agentModels'
import { isListenMode } from '@gugu/core/shared/types/chat'
import type {
  CreateAgentOptions,
  GroupAgentAccount,
  GroupAnnouncement,
  Device,
  DeviceCommand,
  GroupAgentItem,
  ListenMode,
  GroupChatSettings,
  GroupJoinMode,
  GroupJoinRequest,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupMemberRoleInput,
  GroupMemberRole,
  ChatStatus,
  MessageContentType,
  UpdateGroupChatSettingsInput,
  GroupSchedulerState,
  GroupTaskItem,
  GroupTaskPriority,
  GroupTaskStatus,
  MessageItem,
  NotificationLevel
} from '@gugu/core/shared/types/chat'
import {
  applyMessageOverlays,
  loadMessageOverlays,
  revalidateMessageWindow,
  type MessageOverlay,
  type WindowRevalidation,
} from './chatMessageRevalidation'
import {
  forwardCanonicalMessage,
  uploadCanonicalGroupAvatar,
} from './chatCanonicalStorage'
import { writeIdempotentChatMessage } from './chatMessageWriter'
import { readGroupMemberIdentities } from './chatGroupIdentity'
import { requireThreadCapableChat } from './chatThreadGate'
import { addGroupAgent, type GroupAgentJoinOutcome, groupJoinError, listMyAgentJoinRequests } from './groupAgentJoinService'
import { currentGroupAdmin } from './groupAdmin'
export type {
  MessageOverlay,
  MessageMutationPatch,
  WindowRevalidation,
} from './chatMessageRevalidation'


type GroupCollabMemberRow = {
  user_id: string
  role: GroupMemberRole | string
  // #857 Listen Mode：成员的监听档位（chat_members.listen_mode）。
  listen_mode?: string | null
}

type GroupCollabTaskRow = {
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

type GroupCollabAgentStateRow = {
  agent_user_id: string
  client: string | null
  runtime: string | null
  model_source: string | null
  tools: string[] | null
  permission_scope: string | null
  current_task_id: string | null
  last_action: string | null
  last_active_at: string | null
}

function normalizeGroupAgentType(
  value: string | null | undefined
): GroupChatSettings['default_agent_type'] {
  return nullableAgentType(value)
}

interface GroupChatSettingsRow {
  my_role: GroupMemberRole | null; can_manage: boolean; can_dissolve: boolean; can_archive_topic: boolean
  id: string; public_id: number | null; creator_user_id: string | null
  name: string | null
  status: ChatStatus
  group_prompt: string | null
  default_agent_type: string | null
  join_token?: string | null
  description: string | null
  max_members: number | null
  allow_member_invite: boolean | null
  invite_link_enabled: boolean | null
  agent_join_approval: boolean | null
  join_mode: string | null
  hide_history: boolean | null
  // @@@group-avatar (#1164 G1) — 群头像公共 URL（chats.avatar_url）。
  avatar_url: string | null
  // @@@1175 — 群主 opt-in「公开到广场」：默认 false，只有公开的群才进 Explore 公开群发现。
  is_discoverable: boolean | null
  // @@@5856 agent 数量线：自己填的（可空=继承）与继承之后实际生效的那个（DB 计算列）。
  agent_flood_threshold: number | null
  agent_flood_threshold_effective: number | null
}

function normalizeGroupJoinMode(value: string | null | undefined): GroupJoinMode {
  return value === 'approval' || value === 'invite_only' ? value : 'open'
}

function mapGroupChatSettingsRow(row: GroupChatSettingsRow): GroupChatSettings {
  return {
    id: row.id, my_role: row.my_role, can_manage: row.can_manage, can_dissolve: row.can_dissolve, can_archive_topic: row.can_archive_topic,
    public_id: row.public_id,
    creator_user_id: row.creator_user_id ?? null,
    name: resolveOrLoud(row.name, `group chat name ${row.id}`),
    status: row.status,
    group_prompt: row.group_prompt ?? null,
    default_agent_type: normalizeGroupAgentType(row.default_agent_type),
    join_token: row.join_token ?? null,
    description: row.description ?? null,
    max_members: row.max_members ?? 100,
    allow_member_invite: row.allow_member_invite ?? false,
    invite_link_enabled: row.invite_link_enabled ?? true,
    agent_join_approval: row.agent_join_approval ?? false,
    join_mode: normalizeGroupJoinMode(row.join_mode),
    hide_history: row.hide_history ?? false,
    avatar_url: row.avatar_url ?? null,
    is_discoverable: row.is_discoverable ?? false,
    agent_flood_threshold: row.agent_flood_threshold ?? null,
    // ❌ 不补「5」:这个数只能来自 DB 的继承链;编一个默认值 = 用户改的是另一个数(界面据此整行不画)。
    agent_flood_threshold_effective: row.agent_flood_threshold_effective ?? null,
  }
}
function mapGroupCollabAgents(
  members: GroupMemberItem[],
  agentStates: GroupCollabAgentStateRow[],
  tasks: GroupCollabTaskRow[],
  listenModeByUserId: Map<string, ListenMode>
): GroupAgentItem[] {
  const stateByAgentId = new Map(agentStates.map((state) => [state.agent_user_id, state]))
  const taskTitleById = new Map(tasks.map((task) => [task.id, task.title]))
  return members
    .filter((member) => member.type === 'agent')
    .map((member) => {
      const state = stateByAgentId.get(member.id)
      return {
        ...member,
        client: state?.client ?? null,
        model_source: state?.model_source ?? null,
        tools: state?.tools ?? [],
        permission_scope: state?.permission_scope ?? null,
        current_task_id: state?.current_task_id ?? null,
        current_task_title: state?.current_task_id
          ? (taskTitleById.get(state.current_task_id) ?? null)
          : null,
        last_action: state?.last_action ?? null,
        last_active_at: state?.last_active_at ?? null,
        // #857 Listen Mode：从成员查询(chat_members.listen_mode)解析的 map 取，否则默认 active。
        listen_mode: listenModeByUserId.get(member.id) ?? 'active'
      }
    })
}

function buildGroupCollabScheduler(
  schedulerRow: GroupSchedulerState | null,
  chatId: string,
  tasks: GroupTaskItem[]
): GroupSchedulerState {
  const fallbackQueueCount = tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled'
  ).length
  const fallbackBlockedCount = tasks.filter((task) => task.status === 'review').length

  if (schedulerRow) {
    return {
      ...schedulerRow,
      queue_count: schedulerRow.queue_count ?? fallbackQueueCount,
      blocked_count: schedulerRow.blocked_count ?? fallbackBlockedCount
    }
  }

  return {
    chat_id: chatId,
    paused: false,
    queue_count: fallbackQueueCount,
    blocked_count: fallbackBlockedCount,
    summary: null,
    updated_at: new Date().toISOString()
  }
}

const GET_MESSAGES_SOURCES = [
  'initialLoad',
  'loadOlder',
  'loadNewer',
  'toggleReaction',
  'sendReload',
  'rpcQuery',
  'other'
] as const
export type GetMessagesSource = (typeof GET_MESSAGES_SOURCES)[number]

// @@@threads (#957) — 校验拼进 PostgREST .or() 过滤串的 message id 是受信 UUID(防过滤注入)。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// @@@history (#957) — 历史面板「文件」tab 的一条文件记录（媒体附件消息解析所得）。
export interface ChatFileItem {
  messageId: string
  kind: AttachmentKind
  fileName: string
  mimeType: string
  sizeBytes: number
  senderId: string
  createdAt: string
  source: AttachmentSource
}

function deviceCommandTableClient(): DeviceCommandTableClient {
  // @@@supabase-boundary narrow - gugu Supabase's generated generic surface out of core/cloud helpers.
  return identityDb as unknown as DeviceCommandTableClient
}

function deviceTableClient(): DeviceTableClient {
  // @@@supabase-boundary narrow - gugu Supabase's generated generic surface out of core/cloud helpers.
  return identityDb as unknown as DeviceTableClient
}

function deviceRpcClient(): DeviceRpcClient {
  // @@@supabase-boundary narrow - #1749 rename_device / remove_device RPC 走 identity schema。
  return identityDb as unknown as DeviceRpcClient
}

// #1749 设备上绑定的 owned agent（删除设备的级联 UX 用：列出「连同删除」的 agent）。
export type DeviceBoundAgent = { id: string; display_name: string; avatar: string | null }

/** 群名册的一次权威加载 = 成员快照 + 成员身份,同源同出;调用方必须把 identities 一并提交,否则名册里的 id 在 identitiesById 里查不到(群成员没名字 / 空名字当 @ 匹配 key,#5610)。 */
export type GroupCollabLoad = { snapshot: GroupCollabSnapshot; identities: DisplayIdentity[] }

/**
 * 名册读到 0 行。@@@5856 这**不是**「没权限」:话题里它的正常含义是「你看得见这条话题,但还不是
 * 它的参与者」(spec:参与靠说话或被 @ 进来)。调用方据此给一句能照做的话,❌ 不是「关掉再打开一次」。
 */
export class GroupCollabEmptyError extends Error { constructor() { super('Group collab roster is empty for this viewer') } }

export const chatService = {
  /** Per-source counter for getMessages — instrumentation hook for SWR smoke tests.
   *  Incremented on every getMessages call, indexed by required `source` argument. */
  _callCountsBySource: Object.fromEntries(
    GET_MESSAGES_SOURCES.map((source) => [source, 0])
  ) as Record<GetMessagesSource, number>,


  /** Fetch the last `limit` messages for a chat, with sender names and reactions.
   *  `source` is required: it identifies the call site and feeds the per-source
   *  counter so SWR smoke can assert "no redundant reload after sendMessage".
   *  `beforeSeq` (optional) fetches the page strictly OLDER than that seq, for
   *  scroll-up history paging (#504). */
  async getMessages(
    chatId: string,
    userId: string,
    source: GetMessagesSource,
    limit = 60,
    beforeSeq?: number,
    afterSeq?: number
  ): Promise<MessageItem[]> {
    chatService._callCountsBySource[source] = (chatService._callCountsBySource[source] ?? 0) + 1
    // @@@msg-cache-incremental (#621) — `afterSeq` fetches the page strictly NEWER than that seq
    const ascending = typeof afterSeq === 'number'
    let query = chatDb
      .from('messages_view')
      .select(MESSAGES_VIEW_SELECT)
      .eq('chat_id', chatId)
      .is('deleted_at', null)
      // @@@threads (#957) — 主时间线过滤 thread 回复；root 本身保留，由详情按 root 拉取回复。
      .is('thread_root_id', null)
      .eq('is_imported_history_root', false)
      .not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
    if (ascending) query = query.gt('seq', afterSeq as number)
    else if (typeof beforeSeq === 'number') query = query.lt('seq', beforeSeq)
    const { data: msgs, error } = await query.order('seq', { ascending }).limit(limit)
    if (error) throw new Error(error.message)

    if (!msgs?.length) return []

    // messageItemFromRow is the shared mapping. Descending pages (initial/older) reverse to
    // chronological; ascending newer pages are already chronological. The window owner publishes
    // these bodies before its bounded overlay revalidation completes.
    const items = (msgs as RawMessageRow[])
      .map((row) => messageItemFromRow(row, userId))
      .filter((m): m is MessageItem => m !== null)
    return ascending ? items : items.reverse()
  },

  /** @@@threads (#957/#2525) — 群话题 root + 回复，按 seq 正序；主线已过滤回复。 */
  async getThreadMessages(
    chatId: string,
    rootId: string,
    userId: string,
    limit = 50
  ): Promise<MessageItem[]> {
    // rootId 直接拼进 PostgREST .or()，仅接受消息 UUID，非法输入 fail loud。
    if (!UUID_RE.test(rootId)) {
      throw new Error(`getThreadMessages: invalid thread root id ${JSON.stringify(rootId)}`)
    }
    await requireThreadCapableChat(chatId, 'getThreadMessages')
    const { data: msgs, error } = await chatDb
      .from('messages_view')
      .select(MESSAGES_VIEW_SELECT)
      .eq('chat_id', chatId)
      .is('deleted_at', null)
      .not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
      // root 本身(id=rootId, 其 thread_root_id 为 null) + 所有回复(thread_root_id=rootId)
      .or(`id.eq.${rootId},thread_root_id.eq.${rootId}`)
      .order('seq', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    if (!msgs?.length) return []
    const items = (msgs as RawMessageRow[])
      .map((row) => messageItemFromRow(row, userId))
      .filter((m): m is MessageItem => m !== null)
    // 降序取最近 limit 条后翻回时间正序(与 getMessages initial 页一致)。
    return applyMessageOverlays(items.reverse(), userId)
  },

  /** @@@threads (#1196 Q2/#2525) — 幂等标记群话题 root；私聊由服务边界拒绝。 */
  async markThreadRoot(chatId: string, rootId: string): Promise<void> {
    await requireThreadCapableChat(chatId, 'markThreadRoot')
    const { error } = await chatDb.rpc('mark_thread_root', { p_chat_id: chatId, p_root_id: rootId })
    if (error) throw new Error(error.message)
  },

  /** @@@history (#957) — 历史面板「文件」tab：会话内全部媒体附件消息（图片/文档），按 seq 倒序。
   *  messages_view 为 security_invoker → RLS 自动按成员过滤。语音附件 content 格式不同，
   *  parseAttachmentContent 返回 null 被跳过（语音不算文件）；撤回/软删的不计。 */
  async getChatFiles(chatId: string, userId: string): Promise<ChatFileItem[]> {
    const { data, error } = await chatDb
      .from('messages_view')
      .select('id, sender_user_id, content, created_at, file_item_id, file_version, file_blob_id')
      .eq('chat_id', chatId)
      .eq('content_type', 'attachment')
      .is('deleted_at', null)
      .is('retracted_at', null)
      .not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
      .order('seq', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    const out: ChatFileItem[] = []
    for (const row of (data ?? []) as Array<{ id: string; sender_user_id: string; content: string | null; created_at: string; file_item_id: string | null; file_version: number | null; file_blob_id: string | null }>) {
      const meta = parseAttachmentContent(row.content, row)
      if (!meta) continue
      if (typeof row.sender_user_id !== 'string' || !row.sender_user_id) throw new Error(`History file ${row.id} has no sender identity id`)
      out.push({
        messageId: row.id, kind: meta.kind, fileName: meta.fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes,
        senderId: row.sender_user_id, createdAt: row.created_at, source: meta.source,
      })
    }
    return out
  },

  /** @@@msg-cache-incremental (#621) - overlay-only refresh of already-cached message ids (no body
   *  re-fetch). Revalidates reactions / delivery state for the visible window so dropping the per-open
   *  full load doesn't let mutable overlays (which have no realtime for reactions/retract) go stale. */
  async fetchMessageOverlays(
    messageIds: string[],
    userId: string
  ): Promise<Map<string, MessageOverlay>> {
    return loadMessageOverlays(messageIds, userId)
  },

  /** @@@msg-cache (#621/P2/#947) - bounded reopen revalidation over the cached window's ids: reactions +
   *  delivery overlays AND edit/retract body patches AND which ids still exist for this user (deleted rows
   *  fall out of `presentIds`). gugu has no realtime for delete/edit/retract, so this single bounded sweep
   *  keeps the persistent L2 cache correct on reopen WITHOUT a body refetch of new messages. The overlay
   *  fetch and the body-mutation sweep run in parallel. */
  async revalidateWindow(
    messageIds: string[],
    userId: string
  ): Promise<WindowRevalidation> {
    return revalidateMessageWindow(messageIds, userId)
  },

  /** Insert a new message. seq and last_message fields are set by DB triggers.
   *  `id` is required and must be the same UUID the client uses for the optimistic
   *  tempMsg, so realtime echo carries an identical primary key — eliminating the
   *  need for content-based temp/real swap (which caused 3-frame flicker via key churn). */
  async sendMessage(
    chatId: string,
    senderId: string,
    content: string,
    id: string,
    contentType = 'text',
    opts: {
      toUserIds?: string[] | null
      replyToMessageId?: string | null
      // @@@threads (#957/#2525) — 群话题回复；null/缺省为主线消息。
      threadRootId?: string | null
      // @@@threads (#1531/#2525) — 群话题 root，INSERT 时置位供 enqueue 路由。
      isThreadRoot?: boolean
      // @@@whisper (#820) — true = 定向私密消息（仅 sender + to_user_ids 可见）。DB CHECK 要求 whisper 必定向。
      isWhisper?: boolean
    } = {}
  ): Promise<MessageItem> {
    if (opts.threadRootId != null || opts.isThreadRoot === true) await requireThreadCapableChat(chatId, 'sendMessage')
    return writeIdempotentChatMessage({
      id,
      chatId,
      senderUserId: senderId,
      toUserIds: opts.toUserIds?.length ? opts.toUserIds : null,
      content,
      contentType,
      replyToMessageId: opts.replyToMessageId ?? null,
      threadRootId: opts.threadRootId ?? null,
      isThreadRoot: opts.isThreadRoot ?? false,
      isWhisper: opts.isWhisper ?? false,
    })
  },

  async deleteMessage(messageId: string): Promise<{ chatId: string; globallyDeleted: boolean }> {
    const { data, error } = await chatDb.rpc('delete_message', {
      p_message_id: messageId
    })
    if (error) throw new Error(error.message)

    const row = Array.isArray(data) ? data[0] : data
    if (!row || typeof row.chat_id !== 'string') {
      throw new Error(`delete_message returned no chat_id for ${messageId}`)
    }

    return {
      chatId: row.chat_id,
      globallyDeleted: Boolean(row.globally_deleted)
    }
  },

  async clearMessagesForMe(chatId: string): Promise<void> {
    const { error } = await chatDb.rpc('clear_messages_for_me', {
      p_chat_id: chatId
    })
    if (error) throw new Error(error.message)
  },

  async setChatPinned(chatId: string, userId: string, pinned: boolean): Promise<void> {
    const { error } = await chatDb
      .from('chat_members')
      .update(dbPayload({ is_pinned: pinned }))
      .eq('chat_id', chatId)
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
  },

  async setChatNotificationLevel(chatId: string, userId: string, level: NotificationLevel): Promise<void> {
    const { error } = await chatDb
      .from('chat_members')
      .update(dbPayload({ notification_level: level }))
      .eq('chat_id', chatId)
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
  },

  /** Forward an existing message into another chat using the same insert path. */
  async forwardMessage(
    sourceMessageId: string,
    targetChatId: string,
    senderId: string
  ): Promise<{
    id: string
    chat_id: string
    content: string
    content_type: MessageContentType
    created_at: string
  }> {
    return forwardCanonicalMessage(sourceMessageId, targetChatId, senderId)
  },

  async getMessageById(messageId: string, userId: string): Promise<MessageItem | null> {
    const { data: msg, error } = await chatDb
      .from('messages_view')
      .select(MESSAGES_VIEW_SELECT)
      .eq('id', messageId)
      .is('deleted_at', null).not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!msg) return null
    return messageItemFromRow(msg as RawMessageRow, userId)
  },

  markUnread: markMemberUnread,

  /**
   * #1554 解析 DM/ai 单聊对端 user_id。发送时若 activeChat.peer_user_id 未就绪(新开会话
   * 首条、refreshChats 未完成的竞态),用它兜底拿对端,避免 to_user_ids 发成 null →
   * enqueue_agent_deliver 触发器 DM 分支不投递 → agent 首条不运行。
   */
  async getDmPeerUserId(chatId: string, userId: string): Promise<string | null> {
    const { data, error } = await chatDb // 读失败要抛:「没查成」≠「查不到」,吞成 null 会报成「收件人已不可用」
      .from('active_members')
      .select('user_id')
      .eq('chat_id', chatId)
      .neq('user_id', userId)
      .limit(1)
    if (error) throw new Error(error.message)
    return (data as { user_id: string }[] | null)?.[0]?.user_id ?? null
  },

  /** Toggle an emoji reaction on a message. */
  async toggleReaction(messageId: string, userId: string, emoji: string): Promise<void> {
    const { data: existing } = await chatDb
      .from('message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .eq('emoji', emoji)
      .maybeSingle().throwOnError()

    if (existing) {
      await chatDb
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .eq('emoji', emoji).throwOnError()
    } else {
      await chatDb.from('message_reactions').insert(
        dbPayload({
          id: crypto.randomUUID(),
          message_id: messageId,
          user_id: userId,
          emoji
        })
      ).throwOnError()
    }
  },

  /**
   * Returns each OTHER member's last_read_seq, keyed by user_id (the current
   * user is excluded). Read-receipt rendering intersects this with a message's
   * recipients (to_user_ids), so a directed group message flips to read once
   * its recipients — not every member — have read it. For a DM the map holds
   * just the other person's cursor.
   */
  async getOtherMembersReadSeqs(chatId: string, userId: string): Promise<Record<string, number>> {
    const { data, error } = await chatDb
      .from('active_members')
      .select('user_id, last_read_seq')
      .eq('chat_id', chatId)
      .neq('user_id', userId)
    if (error) throw new Error(error.message)
    const seqs: Record<string, number> = {}
    for (const row of (data as { user_id: string; last_read_seq: number }[] | null) ?? []) {
      seqs[row.user_id] = row.last_read_seq
    }
    return seqs
  },

  async getGroupCollab(chatId: string): Promise<GroupCollabLoad> {
    const collabChatDb = dataClient.schema('chat')

    const fetchSnapshotRows = async () => {
      const [schedulerResult, membersResult, tasksResult, agentStatesResult] =
        await Promise.all([
          collabChatDb
            .from('group_scheduler_states')
            .select('chat_id, paused, queue_count, blocked_count, summary, updated_at')
            .eq('chat_id', chatId)
            .maybeSingle(),
          collabChatDb.rpc('list_member_ids', { p_chat_id: chatId }),
          collabChatDb
            .from('group_tasks')
            .select(
              'id, chat_id, title, status, owner_agent_user_id, reviewer_agent_user_id, priority, progress, last_scheduler_summary, sort_order, created_at, updated_at'
            )
            .eq('chat_id', chatId)
            .order('sort_order', { ascending: true })
            .order('updated_at', { ascending: false }),
          collabChatDb
            .from('group_agent_states')
            .select(
              'chat_id, agent_user_id, client, runtime, model_source, tools, permission_scope, current_task_id, last_action, last_active_at, updated_at'
            )
            .eq('chat_id', chatId)
        ])

      // 每一张表读失败都照实抛:附属表(调度 / 任务 / agent 状态)读错不再当成「空」画出来。
      // 读不到的这一次,界面留着缓存的名册(useGroupCollabLoader);下一条成员 / 修订事件再读。
      const read = <T>(label: string, result: { data: T; error: { message: string } | null }) => {
        if (result.error) throw new Error(`${label}: ${result.error.message}`)
        return result.data
      }
      const members = (read('active_members', membersResult) ?? []) as GroupCollabMemberRow[]
      const tasksRaw = (read('group_tasks', tasksResult) ?? []) as GroupCollabTaskRow[]
      const agentStatesRaw = (read('group_agent_states', agentStatesResult) ?? []) as GroupCollabAgentStateRow[]
      const schedulerRow = read('group_scheduler_states', schedulerResult) as GroupSchedulerState | null

      const usersById = await readGroupMemberIdentities(members)

      return { schedulerRow, members, tasksRaw, agentStatesRaw, usersById }
    }

    const snapshot = await fetchSnapshotRows()

    const { schedulerRow, members, tasksRaw, agentStatesRaw, usersById } = snapshot
    if (members.length === 0) {
      // @@@5856 找茬第八轮:话题里这是稳态不是故障(见 GroupCollabEmptyError)。当成抖动重试的话,
      // 界面会一边说「名单没加载出来,关掉再打开一次」,一边在锚点卡上写着「N 条 · M 人」——两句都不真。
      throw new GroupCollabEmptyError()
    }

    const baseMembers = members.map((member) => {
      const identity = usersById.get(member.user_id)
      if (!identity) throw new Error(`Active group member identity is unavailable: ${member.user_id}`)
      return { id: member.user_id, role: normalizeGroupRole(member.role), type: identity.type,
        account_status: identity.type === 'agent' ? 'active' : null } as GroupMemberItem
    })
    const humans = baseMembers.filter((member) => member.type !== 'agent')
    // #857 Listen Mode：从原始成员行建 user_id→listen_mode 映射（DB CHECK 约束保证合法值，非法则回落 active）。
    const listenModeByUserId = new Map<string, ListenMode>(
      members.map((m) => [m.user_id, isListenMode(m.listen_mode) ? m.listen_mode : 'active'])
    )
    const agents = mapGroupCollabAgents(baseMembers, agentStatesRaw, tasksRaw, listenModeByUserId)
    const scheduler = buildGroupCollabScheduler(schedulerRow, chatId, tasksRaw)
    // 名册连同身份一起出门(与 replaceChatRowsAndIdentities 同构):从前 usersById 只用来推 type 就丢掉,下游没有任何写入方。
    return { snapshot: { scheduler, humans, agents, tasks: tasksRaw }, identities: [...usersById.values()] }
  },

  async getGroupChatSettings(chatId: string): Promise<GroupChatSettings> {
    const info = await (await currentGroupAdmin()).info(chatId)
    return mapGroupChatSettingsRow(info as unknown as GroupChatSettingsRow)
  },

  async updateGroupChatSettings(
    chatId: string,
    input: UpdateGroupChatSettingsInput
  ): Promise<GroupChatSettings> {
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new Error('Group name is required')
      patch.name = name
    }
    if (input.status !== undefined) throw new Error('Group status changes use archiveChat')
    if (input.group_prompt !== undefined) patch.group_prompt = input.group_prompt?.trim() || null
    if (input.default_agent_type !== undefined) patch.default_agent_type = input.default_agent_type
    if (input.description !== undefined) patch.description = input.description?.trim() || null
    if (input.max_members !== undefined) {
      if (!Number.isInteger(input.max_members) || input.max_members < 1) throw new Error(i18n.t('group.settings.memberLimitError', { ns: 'messaging' }))
      patch.max_members = input.max_members
    }
    if (input.allow_member_invite !== undefined) patch.allow_member_invite = input.allow_member_invite
    if (input.invite_link_enabled !== undefined) patch.invite_link_enabled = input.invite_link_enabled
    if (input.agent_join_approval !== undefined) patch.agent_join_approval = input.agent_join_approval
    if (input.join_mode !== undefined) {
      if (input.join_mode !== 'open' && input.join_mode !== 'approval' && input.join_mode !== 'invite_only') {
        throw new Error('Invalid join mode')
      }
      patch.join_mode = input.join_mode
    }
    // @@@hide-history (#1018 step4 #860) — 设置位入 patch（按成员门控位由 DB 触发器在入群时置位）
    if (input.hide_history !== undefined) patch.hide_history = input.hide_history
    // 公开到广场 opt-in;权限由 update_group_as 统一判定。
    if (input.is_discoverable !== undefined) patch.is_discoverable = input.is_discoverable
    // @@@5856 agent 数量线。null 是合法值(= 交回去继承),所以这里判的是 undefined,❌ 不是 falsy。
    if (input.agent_flood_threshold !== undefined) {
      const threshold = input.agent_flood_threshold
      if (threshold !== null && (!Number.isInteger(threshold) || threshold < 1)) throw new Error(i18n.t('group.settings.agentFloodThresholdError', { ns: 'messaging' }))
      patch.agent_flood_threshold = threshold
    }
    if (Object.keys(patch).length === 0) return chatService.getGroupChatSettings(chatId)

    const updated = await (await currentGroupAdmin()).update(chatId, patch)
    return mapGroupChatSettingsRow(updated as unknown as GroupChatSettingsRow)
  },

  // 上传到 chat-media 后,由共同 RPC 一次保存 URL 与 storage 引用。
  async uploadGroupAvatar(chatId: string, file: File): Promise<string> {
    return uploadCanonicalGroupAvatar(chatId, file)
  },

  // @@@group-join-mode (#1018 step3 #858) — 凭 token 请求加入：open→直接入群('joined')，
  // approval→建/复活 pending 请求('pending')，invite_only→RPC 抛错。全部经 SECURITY DEFINER RPC。
  async requestGroupJoin(
    publicId: number,
    joinToken: string,
    message?: string | null
  ): Promise<'joined' | 'pending'> {
    const { data, error } = await chatDb.rpc('request_group_join', {
      p_public_id: publicId,
      p_join_token: joinToken,
      p_message: message?.trim() || null,
    })
    if (error) throw new Error(error.message)
    return data === 'joined' ? 'joined' : 'pending'
  },

  // 列出某群的加入请求,含已处理的（仅管理员，RPC 内 can_manage_group_members 校验）。
  async listGroupJoinRequests(chatId: string): Promise<GroupJoinRequest[]> {
    const data = await (await currentGroupAdmin()).joinRequests(chatId)
    const rows = data as Array<{
      id: string
      chat_id: string
      requester_user_id: string
      requester_name: string | null
      requester_avatar: string | null
      message: string | null
      status: string
      created_at: string | null
      requester_type?: string | null; requested_by_user_id?: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      chat_id: r.chat_id,
      requester_user_id: r.requester_user_id,
      requester_type: r.requester_type === 'agent' ? 'agent' as const : 'human' as const, requested_by_user_id: r.requested_by_user_id ?? null,
      requester_name: resolveOrLoud(r.requester_name, `friend-request requester ${r.requester_user_id ?? r.chat_id}`),
      requester_avatar: r.requester_avatar ?? null,
      message: r.message ?? null,
      status: r.status === 'accepted' || r.status === 'rejected' ? r.status : 'pending',
      created_at: r.created_at ?? null,
    }))
  },

  // 审批一条加入请求（仅管理员）：accept→入群+标 accepted，reject→标 rejected。
  async decideGroupJoin(requestId: string, accept: boolean): Promise<'accepted' | 'rejected'> {
    try {
      const result = await (await currentGroupAdmin()).decideJoin(requestId, accept)
      return result.status as 'accepted' | 'rejected'
    } catch (error) { throw groupJoinError(error as Error) }
  },

  async createOwnedAgent(
    displayName: string,
    options: CreateAgentOptions
  ): Promise<GroupAgentAccount> {
    const name = normalizeAgentDisplayName(displayName)
    if (!options.deviceId) throw new Error('Device is required to create an agent')
    const agentType = options.agentType ?? DEFAULT_AGENT_TYPE
    const projectPath = normalizeAgentProjectPath(options.projectPath) ?? null
    const avatar = options.avatar?.trim() || null

    const specialFocus = options.specialFocus?.trim() || null
    const { data, error } = await identityDb.rpc('create_owned_agent', {
      p_display_name: name,
      p_avatar: avatar,
      p_agent_type: agentType,
      p_device_id: options.deviceId,
      p_local_path: projectPath,
      p_prompt_path: null,
      // @@@1390 继承记忆(缺省 true) + 具体目标 真落库。
      p_inherit_memory: options.inheritMemory ?? true,
      p_special_focus: specialFocus
    })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as {
      id: string
      gugu_number?: number | null
      display_name: string
      avatar: string | null
      created_at: string | null
    }[]
    const row = rows[0]
    if (!row) throw new Error('Agent was not created')
    return {
      id: row.id,
      gugu_number: row.gugu_number ?? null,
      display_name: row.display_name,
      avatar: row.avatar ?? null,
      email: null,
      created_at: row.created_at ?? null
    }
  },

  // @@@local-device-self-merge - The local desktop process knows it is online without
  async listDevices(options: { includePhones?: boolean; deviceIds?: readonly string[] } = {}): Promise<Device[]> {
    const [self, cloud] = await Promise.all([
      platform.getLocalDeviceSelfSnapshot?.() ?? Promise.resolve(null),
      listCoreDevices(deviceTableClient(), await getCurrentAuthUserId(), options) // @@@1962 按当前用户过滤设备(多账号同机不混入他人行);#7199 手机默认不在
    ])
    return markLocalDevice(self, cloud, !!platform.getLocalDeviceSelfSnapshot)
  },

  // #1749 rename/remove 走受控 RPC(core service)。
  async renameDevice(deviceId: string, label: string): Promise<void> {
    await renameCoreDevice(deviceRpcClient(), deviceId, label)
  },

  async removeDevice(deviceId: string, options: { cascade?: boolean } = {}): Promise<void> {
    await removeCoreDevice(deviceRpcClient(), deviceId, options)
  },

  // #1749 删除设备的级联 UX：列出该设备上绑定的 owned agent（供「连同 agent 一起删」清单展示）。
  async listAgentsOnDevice(deviceId: string): Promise<DeviceBoundAgent[]> {
    return await readDeviceDisplayIdentities(deviceId)
  },

  // #1099: chatService.wakeAgent 已删 —— ACP 下 agent=spawn+stdio,设备在线即可触达、发消息自动启动
  // 会话,不存在 terminal 时代「先唤醒」机制。后端 agent.wake 命令链(deviceCommands/deviceCommandRuntime)
  // 一并随 #966 退役。

  async getDeviceCommand(commandId: string): Promise<DeviceCommand | null> {
    return getCoreDeviceCommand(deviceCommandTableClient(), commandId)
  },

  // @@@1594 警示:默认 90_000 远小于 runtime 的 AGENT_INIT_HELD_TIMEOUT_MS(create 重试 held 窗口,现 150s)。
  // 等待会「落终态(done/error)即 resolve/reject,否则到 timeout 超时」——窗口内未落终态则超时,是「仍在跑」
  // 的信号,不是真失败;不做超时后状态复核的调用方需自行保证余量。
  async waitForDeviceCommand(commandId: string, timeoutMs = 90_000): Promise<DeviceCommand> {
    return pollDeviceCommandUntilDone(() => chatService.getDeviceCommand(commandId), { timeoutMs })
  },

  /** 把自己名下的 agent 拉进群;需审批而你不是管理员时返回 pending_approval(见 groupAgentJoinService)。 */
  async joinGroupAgent(chatId: string, agentUserId: string, role?: GroupMemberRoleInput): Promise<GroupAgentJoinOutcome> {
    return addGroupAgent(chatId, agentUserId, normalizeGroupRole(role))
  },

  listMyAgentJoinRequests,
  // 主人选择自己 Agent 的档位;数据库核实际 actor,并回执保存值。
  async setAgentListenMode(chatId: string, agentUserId: string, mode: ListenMode): Promise<void> {
    await (await currentGroupAdmin()).setListenMode(chatId, agentUserId, mode)
  },

  // Owner/admin may promote or demote any non-owner member.
  async setGroupMemberRole(chatId: string, memberUserId: string, role: GroupMemberRoleInput): Promise<void> {
    const next = normalizeGroupRole(role)
    if (next === 'owner') throw new Error('Group ownership cannot be changed here')
    await (await currentGroupAdmin()).setRole(chatId, memberUserId, next)
  },

  // Related identities join directly; everyone else receives a consent invitation.
  async inviteGroupMember(chatId: string, userId: string) {
    const admin = await currentGroupAdmin()
    const group = await admin.info(chatId)
    return admin.invite(chatId, userId, `邀请你加入群聊「${String(group.name)}」。`)
  },

  // @@@remove-member - Generic remove (manager removing a member, or an owner taking their own agent out); for agents this also cleans up group_agent_states.
  async removeGroupMember(chatId: string, userId: string): Promise<void> {
    await (await currentGroupAdmin()).remove(chatId, userId)
  },

  /**
   * Create a group chat and add all member IDs (creator becomes owner). Returns the new chat ID.
   * groupPrompt(章程)随建群经 SECURITY DEFINER RPC 一次性写入——chats.group_prompt 无客户端 GRANT UPDATE,建群后分开 update 会 RLS 失败(@@@preset-team)。
   */
  async createGroupChat(name: string, creatorId: string, memberIds: string[], groupPrompt?: string | null) {
    const identities = await readDisplayIdentities([...new Set(memberIds)])
    if (identities.length !== new Set(memberIds).size) throw new Error('Selected group member was not found')
    return createGroupWithInvitations(chatDb, name, creatorId, await getCurrentAuthUserId(), identities, groupPrompt)
  },

  /** Archive a chat so it disappears from getChats() for every member. */
  async archiveChat(chatId: string): Promise<void> {
    await (await currentGroupAdmin()).archive(chatId)
  },

  /**
   * Find or create a DM chat between the current user and a target user.
   * Returns the chat ID.
   */
  async getOrCreateDM(currentUserId: string, targetUserId: string): Promise<string> {
    if (!targetUserId || targetUserId === currentUserId) throw new Error('Invalid DM target')
    const { data, error } = await chatDb.rpc('open_dm', {
      p_target_user_id: targetUserId
    })
    if (error) throw new Error(error.message)
    if (typeof data !== 'string' || data.length === 0)
      throw new Error('DM creation returned no chat id')
    return data
  },

  // @@@group-announcements (#986) — 群公告 CRUD. Pinned announcements sorted first, then newest first.
  // @@@announcement-likes (#1115) — 嵌入点赞行（chat.group_announcement_likes，FK announcement_id），
  //   likeCount = 行数，likedByMe = 当前用户是否在其中。
  async getAnnouncements(chatId: string): Promise<GroupAnnouncement[]> {
    const myId = await getCurrentAuthUserId()
    const { data, error } = await chatDb
      .from('group_announcements')
      .select('id, chat_id, author_id, content, pinned, created_at, group_announcement_likes(user_id)')
      .eq('chat_id', chatId)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    // TODO: resolve author profile (display_name + avatar) via a join or lookup
    return (
      (data ?? []) as {
        id: string
        chat_id: string
        author_id: string
        content: string
        pinned: boolean
        created_at: string
        group_announcement_likes: { user_id: string }[] | null
      }[]
    ).map((row) => {
      const likes = row.group_announcement_likes ?? []
      return {
        id: row.id,
        chatId: row.chat_id,
        authorId: row.author_id,
        authorName: null,
        authorAvatarUrl: null,
        content: row.content,
        pinned: row.pinned,
        createdAt: row.created_at,
        likeCount: likes.length,
        likedByMe: likes.some((l) => l.user_id === myId),
      }
    })
  },

  async postAnnouncement(chatId: string, content: string): Promise<void> {
    await (await currentGroupAdmin()).postAnnouncement(chatId, content)
  },

  // 管理员编辑公告;使用与 agent 相同的 RPC。
  async editAnnouncement(announcementId: string, content: string): Promise<void> {
    await (await currentGroupAdmin()).updateAnnouncement(announcementId, { content })
  },

  // 公告置顶也由共同 RPC 判权。
  async setAnnouncementPinned(announcementId: string, pinned: boolean): Promise<void> {
    await (await currentGroupAdmin()).updateAnnouncement(announcementId, { pinned })
  },

  async deleteAnnouncement(announcementId: string): Promise<void> {
    await (await currentGroupAdmin()).deleteAnnouncement(announcementId)
  },

  // @@@announcement-likes (#1115) — 点赞 / 取消（成员均可；RLS announcement_likes_insert_own/delete_own）。
  async setAnnouncementLike(announcementId: string, liked: boolean): Promise<void> {
    const userId = await getCurrentAuthUserId()
    if (liked) {
      const { error } = await chatDb
        .from('group_announcement_likes')
        .upsert(dbPayload({ announcement_id: announcementId, user_id: userId }), {
          onConflict: 'announcement_id,user_id',
          ignoreDuplicates: true,
        })
      if (error) throw new Error(error.message)
    } else {
      const { error } = await chatDb
        .from('group_announcement_likes')
        .delete()
        .eq('announcement_id', announcementId)
        .eq('user_id', userId)
      if (error) throw new Error(error.message)
    }
  },
}
