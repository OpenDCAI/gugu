/**
 * delivery-routing S2b —— 聊天消息的读者(pull/收件箱模型)。
 *
 * agent 的会话是一个读者:云端聊天是唯一耐久层(消息本体 + last_read_seq 水位 + 逐条精确读行),
 * 本机不保存聊天消费水位;归档只额外持久记录拒投 ID,不伪造已读。session_spawn 的本机 outbox 是兼容投影,取走即删。
 * 四个触发(nudge / 回合结束 / 会话唤醒完成 / 开机扫)
 * 都收敛到 pullAgentInbox:按 (chat, seq) 顺序拉出该交给这个 agent 的未读 —— 「这条消息唤醒谁」由云端
 * 唯一的谓词 chat.message_wakes_agent 回答(投递触发器与 pull_agent_inbox 共用),reader 不做资格判断 ——,逐条 admission
 * (每条消息保留自己完整的 <gugu_delivery> 段),按 transport 的交付边界进入注入口:idle-only 行逐条进入收件会话队列,
 * 由队列 drain 调用唯一 mergeDeliveryEnvelopes producer;next-tool-call 行没有 gugu 侧队列,在 steer admission
 * 处用同一 producer 合成当次可见批次。云端行受理后按 seq 序推进游标(mark_read_on_deliver);
 * 本机行受理后删除 outbox 行。两者都先注入后确认,注入失败不会静默丢失。
 *
 * 去重 = 游标单调:floor 是水位,已消费排除靠精确读行(水位的 gap gate 只看「中间存在他人消息」,
 * whisper 也计入,可以永久停滞 —— 生产现状 #1529B,所以精确读行才是逐条消费事实;两者都在
 * pull_agent_inbox RPC 里收口)。并发触发由 per-agent coalescing single-flight 合并
 * (内存,不持有任何跨进程/跨崩溃真值:进程死,守卫与工作同死,游标未推进,重启重拉)。
 */
import { createHash } from 'node:crypto'
import type { FileRef } from '../../shared/fileResolver'
import { getSupabaseAnonKey, getSupabaseUrl } from '../../cloud/config'
import { resolveListenModeDefault } from '../../cloud/listenMode'
import type { ChatKind } from '../../shared/types/chat'
import { parseAttachmentContent } from '../../shared/ui/attachmentModels'
import { attachmentFolderLine } from '../../shared/attachmentFolderLine'
import {
  buildAgentDeliveryEnvelope,
  buildAgentMentionContext,
  formatDeliveryTimestamp,
  identityShown,
  mergeDeliveryEnvelopes,
  type AgentDeliveryToolNames,
  type GuguIdentity,
} from './deliveryEnvelope'
import { markAgentDeliveredMessageRead, type AgentDeliveredMessageRead } from './deliveredReadMarkers'
import { buildThreadBootstrapBody, type ThreadMessageRow } from './threadBootstrap'
import {
  decideGroupRulesDelivery,
  effectiveGroupRules,
  fetchChatFactsViaRpc,
  groupRulesLedgerFor,
  type ChatFactsRow,
  type DeliveredGroupRules,
  type GroupRulesLedger,
} from './groupRulesDelivery'
import { encodeTypedId } from '../../shared/typedId.mjs'
import { ackForumViaRpc, recordForumFailureViaRpc, type ForumDeliveryFailure } from './forumInbox'
import { coreLogger } from '../../log'
import { agentFailureNeedsModelChoice, agentFailureReason, type AgentFailureReason } from '../../shared/agentQuotaReason'
import { turnFailureMarker } from '../../shared/ui/systemNotice'
import { sessionArchiveRefusesMessage, type SessionArchivalState } from '../../shared/sessionArchival'
import { beginInboxAttempt, clearInboxRetry, resetInboxRetries, retryInboxFailure } from './inboxRetry'
import { attachmentFailureReason, attachmentStage } from '../files/attachmentDiagnostics'

const log = coreLogger('agent-inbox-reader')

/** 一行 = pull_agent_inbox RPC 的一行(字段名 camelCase 化)。 */
export interface AgentInboxUnreadRow {
  chatId: string
  chatKind: ChatKind | null
  chatPublicId: number | null
  chatName: string | null
  chatCreatorUserId: string | null
  listenMode: string | null
  notificationLevel: string | null
  lastReadSeq: number
  id: string
  seq: number
  senderUserId: string | null
  senderType: string | null
  senderDisplayName: string | null
  senderGuguNumber: number | null
  content: string
  contentType: string | null
  toUserIds: string[] | null
  isWhisper: boolean
  /** App 以人的名义送来的那一行(`gugu.dispatch`,#6835):App 的 extension id。 */
  viaApp?: string | null
  /**
   * #7290 附件消息指向群文件夹的条目与版本(新式附件);条目删了 ⇒ itemId 为 null。从 pull_agent_inbox_v2 来的行一定带着
   * (fileRefOf 要求库回这两列);本机会话直投的行不是附件,没有。
   */
  fileItemId?: string | null
  fileVersion?: number | null
  /** 悄悄话的附件:消息直接指字节(不进群文件夹)。 */
  fileBlobId?: string | null
  replyToMessageId: string | null
  replyToSenderUserId: string | null
  replyToContent: string | null
  threadRootId: string | null
  isThreadRoot: boolean
  createdAt: string
  /**
   * Server-side monotonic fence bounding this finite scan (`chat.messages.ingest_seq`); never a read receipt.
   * #6327: this used to be a wall-clock timestamp, and a DB clock stepping back made an already-pushed message
   * "future" to the pull that its own nudge triggered — push and pull disagreed. A sequence has no clock to step.
   */
  scanFence?: number
  /** Local session-direct rows are fed into this same reader without inventing a cloud chat. */
  localSessionDirect?: { sessionId: string; envelope: string }
  /** 论坛来源的一行(forumInbox.ts):帖子上该交给它的一件事,信封已做好;受理后按帖子确认 seq。 */
  forum?: { postId: string; seq: number; envelope: string }
}

/**
 * 注入尝试的判决(通道给出;投递层不检查忙闲、不因忙扣消息)。`enqueued`: the host's session lifecycle owner took the unit
 * into its durable queue; its rows are marked read only when the agent accepts it (the host calls markInboxRowsRead).
 */
export type AgentInboxInjectionVerdict = 'accepted' | 'enqueued' | 'not-live' | 'not-now'

/** Provider admission plus an optional out-of-band turn settlement. */
export type AgentInboxInjectionResult = AgentInboxInjectionVerdict | {
  verdict: AgentInboxInjectionVerdict
  completion?: Promise<void>
}

export interface AgentInboxInjectionInput {
  agentUserId: string
  /** 稳定注入 id = 批首条消息的 msg id(幂等重放/审计锚;单条时即该条)。 */
  messageId?: string
  text: string
  /**
   * The rows this unit settles once accepted (its members, and skipped rows it passes): an enqueuing host freezes them.
   * Absent: a host-made unit (a notice) with no inbox row behind it.
   */
  sources?: readonly AgentInboxSource[]
  /** Image bytes travel as content blocks, never as a URL for the agent to fetch. */
  attachments?: Array<{ data: string; mimeType: string; fileName: string; localPath?: string }>
}

export type AgentInboxDeliveryTiming = 'next-tool-call' | 'idle-only'

export interface AgentInboxFetchInput {
  agentUserId: string
  chatId?: string
  afterSeq?: number
  limit?: number
  /** Exclusive key in the RPC's (chat_id, seq) order, local to one scan. */
  scanAfter?: { chatId: string; seq: number }
  /** Reuse the first page's server fence so a busy chat cannot extend this scan forever. */
  scanFence?: number
}

export interface AgentInboxReaderDeps {
  recipientIsRegistered?: (agentUserId: string) => boolean | Promise<boolean>
  accessToken: string
  /** Host-owned durable refusal intervals; suppressed rows are never marked read. */
  sessionArchival?: (agentUserId: string) => SessionArchivalState | null | Promise<SessionArchivalState | null>
  /** Host persists refused message IDs separately from read receipts. */
  sessionMessageRefused?: (agentUserId: string, messageId: string, createdAt: string) => boolean | Promise<boolean>
  ownerUserId?: string
  env?: NodeJS.ProcessEnv
  /** conversation 键控注入口(host 提供)。抛异常 = 真失败(批保持未读并披露);三态见类型。 */
  inject: (input: AgentInboxInjectionInput) => Promise<AgentInboxInjectionResult>
  /** 冷会话唤醒踢一脚——不 await(收信方开机代价不进任何调用方的 round-trip)。 */
  wake?: (agentUserId: string) => void
  deliveryToolNames?: (agentUserId: string) => AgentDeliveryToolNames | null
  /** Per-harness admission tier; next-tool-call rows merge at the immediate steer boundary. */
  deliveryTiming?: (agentUserId: string) => AgentInboxDeliveryTiming | null | Promise<AgentInboxDeliveryTiming | null>
  /** injectable:云端拉取(默认走 pull_agent_inbox RPC)。 */
  fetchUnread?: (input: AgentInboxFetchInput) => Promise<AgentInboxUnreadRow[]>
  /** Pending local session-direct rows, projected into the same reader/merge path. */
  fetchLocalUnread?: (agentUserId: string) => Promise<AgentInboxUnreadRow[]>
  /** Delete a local session-direct outbox row only after provider acceptance. */
  markLocalRead?: (input: { agentUserId: string; sessionId: string; messageId: string }) => Promise<void>
  /** injectable:游标推进(默认 mark_read_on_deliver)。 */
  markRead?: (input: AgentDeliveredMessageRead) => Promise<void>
  /** Rows an enqueuing host already holds in its queue (still unread until accepted): left out of every new unit. */
  claimedSources?: (agentUserId: string, messageIds: readonly string[]) => ReadonlySet<string> | Promise<ReadonlySet<string>>
  /**
   * 论坛来源(forumInbox.ts):有它才拉论坛(宿主的装配 agentInboxDepsFromBridge 接上 forum_pull_agent_inbox);确认与失败记录
   * 默认 forum_ack / forum_record_delivery_failure。
   */
  fetchForumUnread?: (agentUserId: string) => Promise<AgentInboxUnreadRow[]>
  ackForum?: (input: { agentUserId: string; postId: string; seq: number }) => Promise<void>
  recordForumFailure?: (input: { agentUserId: string; postId: string; state: ForumDeliveryFailure; error: string }) => Promise<void>
  fetchThreadMessages?: (chatId: string, threadRootId: string) => Promise<ThreadMessageRow[]>
  resolveGuguIds?: (
    userIds: Array<string | undefined>,
    accessToken: string | undefined,
  ) => Promise<Map<string, GuguIdentity>>
  /** injectable:批失败披露(默认稳定 id 直插 system 行;无 lease)。 */
  postDisclosure?: (input: DisclosureRow) => Promise<void>
  /** injectable:这个 agent 在这条线上、这个 seq 之后自己说过话没有(默认 chat.message_history_as,按 agent 的可见域)。 */
  agentSpokeAfter?: (input: AgentSpokeAfterInput) => Promise<boolean>
  // @@@5856 checkAgentReplied / must-reply 违约判定已随**老 active 档**一起退役。
  // 两档之后留下的 active 是「叫得醒它,回不回它自己判断」——对这样的档位判「该回没回」,
  // 判出来的全是假违约,而它喂的是 recordDeliverOutcome 那盏异常计数灯。
  /**
   * #3641 这个 agent 此刻所在的那一段 provider 上下文的标识(换了新上下文 ⇒ 值变 ⇒ 群规重达)。
   * 缺席或回 null = 宿主报不出,按同一段处理。
   */
  deliveryContextKey?: (agentUserId: string) => string | null | Promise<string | null>
  /** injectable:按 agent 身份读一条线的基本事实(默认 chat.chat_facts)。群规由此现取。 */
  fetchChatFacts?: (chatId: string, asUserId: string) => Promise<ChatFactsRow | null>
  /** injectable:群规已送达记录(默认落盘在 GUGU_HOME)。 */
  groupRulesLedger?: GroupRulesLedger
  /** #2175 异常计数灯:喂灯点从命令结果迁到读者注入结果。 */
  onOutcome?: (outcome: { agentUserId: string; ok: boolean }) => void
  /** Product-level audit: one callback per injectBatch, recording the rows seen together. */
  onBatch?: (batch: { agentUserId: string; rows: number; units: number }) => void
  /** The host exports a verified original through the canonical resolver, as this inbox agent. */
  downloadAttachment?: (
    ref: FileRef,
    fileName: string,
    agentUserId: string,
  ) => Promise<SavedAttachment>
  nowIso?: () => string
}

export interface AgentInboxPullResult {
  /** 本轮实际取到的未读行数(RPC 去重后;每一行都是该交给这个 agent 的)。 */
  pulled: number
  /** 注入成功且云端游标已推进或本机行已删除的行数。 */
  injected: number
  verdict: 'idle' | AgentInboxInjectionVerdict
  /** Resolves when all provider turns admitted by this pull have settled. */
  completion?: Promise<void>
}

// ── 进程内状态(全部无跨崩溃真值;进程死即死,重启由云端游标重建) ────────────────
type SingleFlight = { promise: Promise<AgentInboxPullResult>; rerun: boolean }
const inFlightByAgent = new Map<string, SingleFlight>()
/** @@@1379 thread bootstrap 首进标记(与旧 deliver 同语义:注入成功才落,重启即清)。 */
const threadBootstrapped = new Set<string>()
const batchAudit: Array<{ agentUserId: string; rows: number; units: number }> = []

export function resetAgentInboxReaderStateForTests(): void {
  resetInboxRetries()
  inFlightByAgent.clear()
  threadBootstrapped.clear()
  batchAudit.length = 0
}

/** Test-only product readout for the real Electron inbox path. */
export function readAgentInboxBatchAuditForTest(): Array<{ agentUserId: string; rows: number; units: number }> {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('agent inbox batch audit is disabled')
  }
  return batchAudit.map((entry) => ({ ...entry }))
}

const PULL_LIMIT = 80

// ── 缺省云端实现 ────────────────────────────────────────────────────────────────
async function fetchUnreadViaRpc(
  input: AgentInboxFetchInput,
  accessToken: string,
): Promise<AgentInboxUnreadRow[]> {
  const response = await fetch(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/rpc/pull_agent_inbox_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'identity',
      'Content-Profile': 'identity',
    },
    body: JSON.stringify({
      p_agent_user_id: input.agentUserId,
      p_chat_id: input.chatId ?? null,
      p_after_seq: input.afterSeq ?? null,
      p_limit: input.limit ?? PULL_LIMIT,
      p_scan_after: input.scanAfter ? { chat_id: input.scanAfter.chatId, seq: input.scanAfter.seq } : null,
      p_scan_max_ingest_seq: input.scanFence ?? null,
    }),
  })
  if (!response.ok) {
    throw new Error(`pull_agent_inbox_v2 failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  }
  const rows = (await response.json()) as Array<Record<string, unknown>>
  return rows.map(unreadRowFromRpc)
}

/** pull_agent_inbox_v2 必须回这三列(gugu-supabase #129 的 delta):没回就是库和客户端不配套,❌ 当成「文件已删」悄悄交下去。 */
function fileRefOf(raw: Record<string, unknown>): { fileItemId: string | null; fileVersion: number | null; fileBlobId: string | null } {
  if (!('file_item_id' in raw) || !('file_version' in raw) || !('file_blob_id' in raw)) {
    throw new Error('pull_agent_inbox_v2 row has no file_item_id / file_version / file_blob_id: the database is older than this client')
  }
  return {
    fileBlobId: typeof raw.file_blob_id === 'string' ? raw.file_blob_id : null,
    fileItemId: typeof raw.file_item_id === 'string' ? raw.file_item_id : null,
    fileVersion: typeof raw.file_version === 'number' ? raw.file_version : null,
  }
}

export function unreadRowFromRpc(raw: Record<string, unknown>): AgentInboxUnreadRow {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  return {
    chatId: String(raw.chat_id),
    chatKind: (text(raw.chat_kind) as ChatKind | null) ?? null,
    chatPublicId: num(raw.chat_public_id),
    chatName: text(raw.chat_name),
    chatCreatorUserId: text(raw.chat_creator_user_id),
    listenMode: text(raw.listen_mode),
    notificationLevel: text(raw.notification_level),
    lastReadSeq: Number(raw.last_read_seq ?? 0),
    id: String(raw.id),
    seq: Number(raw.seq),
    senderUserId: text(raw.sender_user_id),
    senderType: text(raw.sender_type),
    senderDisplayName: text(raw.sender_display_name),
    senderGuguNumber: num(raw.sender_gugu_number),
    content: String(raw.content ?? ''),
    contentType: text(raw.content_type),
    toUserIds: Array.isArray(raw.to_user_ids)
      ? raw.to_user_ids.filter((value): value is string => typeof value === 'string')
      : null,
    isWhisper: raw.is_whisper === true,
    viaApp: text(raw.via_app) || null,
    ...fileRefOf(raw),
    replyToMessageId: text(raw.reply_to_message_id),
    replyToSenderUserId: text(raw.reply_to_sender_user_id),
    replyToContent: text(raw.reply_to_content),
    threadRootId: text(raw.thread_root_id),
    isThreadRoot: raw.is_thread_root === true,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    scanFence: raw.scan_max_ingest_seq === null || raw.scan_max_ingest_seq === undefined
      ? undefined
      : Number(raw.scan_max_ingest_seq),
  }
}

type InlineImage = { data: string; mimeType: string; fileName: string; localPath: string }
type SavedAttachment = { bytes: Uint8Array; localPath: string }

export type DisclosureRow = { agentUserId: string; chatId: string; threadRootId: string | null; key: string; reason: AgentFailureReason; replyToMessageId?: string }

/**
 * The failure row's content: what agents and clients that cannot read the reason see. Fixed English, so an agent reads the
 * same words whatever the viewers' language; a client that reads the reason (`systemNotice.ts`) says it in its own language.
 * Retained admission gaps use a Chinese pending notice rather than a terminal failure.
 */
const FAILURE_CONTENT: Record<AgentFailureReason, string> = {
  weeklyQuota: 'Weekly usage limit reached for this model account. Switch models or wait for the limit to reset.',
  monthlyQuota: 'Monthly usage limit reached for this model account. Switch models or wait for the limit to reset.',
  quota: 'This model account has reached its usage limit. Switch models or top up, then retry.',
  rateLimited: 'Too many requests to this model. Please try again shortly.',
  modelUnavailable: 'The current model is not available or is at capacity. Resend later, or switch models and resend.',
  authentication: 'The model service refused authorization for this reply.',
  network: 'The connection to the model service was interrupted; this reply could not be completed.',
  timeout: 'The model service did not respond in time; this reply could not be completed.',
  generic: 'This reply could not be completed. Please try again later.',
  notAdmitted: '消息已保留，助理就绪后回复。',
  undelivered: 'Not delivered yet: no running Gugu instance on this device holds this agent. The message stays unread until that instance is open.',
}

/**
 * The notice row's message id. Message ids are UUIDs everywhere a message is addressed (typed `msg:` ids, conversation
 * links), so the notice gets one too — derived from its dedupe key, so the same failure posted again lands on the same
 * row (409) and stays one notice. Rows written before this used the key itself as the id; readers still accept them.
 */
export function disclosureMessageId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * 披露:稳定 id 直插 system 行(#2935 幂等;409 = 已披露过,幂等命中)。无 command lease。原因编在 client_message_id(systemNotice.ts)。
 * 也是 [[device-command-runtime]] 对「无人持有的 agent」终态显形(#5041)用的同一条写口——聊天里对用户可见的失败只有这一种形状。
 */
export async function postDeliveryDisclosureRow(input: DisclosureRow, accessToken: string): Promise<void> {
  const id = disclosureMessageId(input.key)
  const response = await fetch(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'chat',
      'Content-Profile': 'chat',
    },
    body: JSON.stringify({
      id,
      chat_id: input.chatId,
      sender_user_id: input.agentUserId,
      content: FAILURE_CONTENT[input.reason],
      content_type: 'system',
      client_message_id: turnFailureMarker(id, input.reason),
      ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
      thread_root_id: input.threadRootId,
      is_thread_root: false,
    }),
  })
  if (response.ok || response.status === 409) return
  throw new Error(`turn-failure disclosure insert failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
}

export type AgentSpokeAfterInput = { agentUserId: string; chatId: string; threadRootId: string | null; afterSeq: number }

/** The agent's own non-system message on this line after `afterSeq`, read as the agent (`chat.message_history_as`). */
export async function agentSpokeAfterViaRpc(input: AgentSpokeAfterInput, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/rpc/message_history_as`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'chat',
      'Content-Profile': 'chat',
    },
    body: JSON.stringify({ p_chat_id: input.chatId, p_as_user_id: input.agentUserId, p_thread_root_id: input.threadRootId, p_limit: 20 }),
  })
  if (!response.ok) throw new Error(`message_history_as failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  const rows = (await response.json()) as unknown
  if (!Array.isArray(rows)) throw new Error('message_history_as returned no row list')
  return rows.some((row: { seq?: unknown; sender_user_id?: unknown; content_type?: unknown }) =>
    Number(row.seq) > input.afterSeq && row.sender_user_id === input.agentUserId && row.content_type !== 'system')
}

// ── 读者主体 ────────────────────────────────────────────────────────────────────
/**
 * 拉一批并注入。并发触发合并进下一次运行(coalescing single-flight):任一时刻每个 agent 至多
 * 一个在飞读者;pull 进行中再被触发 → 记 rerun,本轮结束后立刻再跑一轮(不丢触发)。
 */
export function pullAgentInbox(agentUserId: string, deps: AgentInboxReaderDeps): Promise<AgentInboxPullResult> {
  const existing = inFlightByAgent.get(agentUserId)
  if (existing) {
    existing.rerun = true
    return existing.promise
  }
  beginInboxAttempt(agentUserId)
  const flight: SingleFlight = { rerun: false, promise: Promise.resolve({ pulled: 0, injected: 0, verdict: 'idle' }) }
  flight.promise = (async () => {
    try {
      let result = await pullOnce(agentUserId, deps)
      const completions = result.completion ? [result.completion] : []
      while (flight.rerun) {
        flight.rerun = false
        result = combineCoalescedPulls(result, await pullOnce(agentUserId, deps))
        if (result.completion) completions.push(result.completion)
      }
      const summary: AgentInboxPullResult = { pulled: result.pulled, injected: result.injected, verdict: result.verdict }
      clearInboxRetry(agentUserId)
      return completions.length > 0
        ? { ...summary, completion: Promise.all(completions).then(() => undefined) }
        : summary
    } catch (error) {
      retryInboxFailure(agentUserId, error, () => kickAgentInboxPull(agentUserId, deps, 'failure-retry'))
      throw error
    } finally {
      if (inFlightByAgent.get(agentUserId) === flight) inFlightByAgent.delete(agentUserId)
    }
  })()
  inFlightByAgent.set(agentUserId, flight)
  return flight.promise
}

/**
 * 一次 single-flight 里前后几轮 pull 的合账:行数与注入数累加;判决取最后一轮(它才是此刻的事实),
 * 最后一轮空手(idle)时保留前一轮的判决 —— 空拉不改变「刚才投进去了 / 会话不 live」这件事。
 * 以前只报最后一轮 —— 首轮注入 1 条、rerun 读到已推进的游标拉回 0 条,日志就写成「pulled 0 injected 0」,
 * 与「什么都没投」长得一模一样(#6264 取证时正是这行把一次真实投递藏住了)。
 * `completion` 只取后一轮自己的,聚合由调用方收口。
 */
export function combineCoalescedPulls(
  earlier: AgentInboxPullResult,
  later: AgentInboxPullResult,
): AgentInboxPullResult {
  return {
    pulled: earlier.pulled + later.pulled,
    injected: earlier.injected + later.injected,
    verdict: later.verdict === 'idle' ? earlier.verdict : later.verdict,
    ...(later.completion ? { completion: later.completion } : {}),
  }
}

/** 触发入口(fire-and-forget):失败响亮记录，由失败退避计时重新拉取未读。 */
export function kickAgentInboxPull(agentUserId: string, deps: AgentInboxReaderDeps, trigger: string): void {
  log.info({ agentUserId, trigger }, 'agent inbox pull kicked')
  void pullAgentInbox(agentUserId, deps).then(
    (result) => {
      // 「踢了一脚」和「这一脚拿回了什么」是两件事。以前只记前者：一次 pulled=0 的空拉
      // 在日志里与「拉到并注入了」长得一模一样，而空拉恰恰是会话僵在启动态的那个状态
      // （codex 全新会话要等首轮投递才起终端，空拉 = 静默等满 90 秒）。
      log.info(
        { agentUserId, trigger, pulled: result.pulled, injected: result.injected, verdict: result.verdict },
        'agent inbox pull done',
      )
      // 受理之后 provider 那一轮的结算由宿主出带收口并 loud log(spec delivery-routing「受理与回合结算分离」)。
      // 这条踢出来的 pull 没有 device command 替它接 completion:不接,serve 腿的完成预算耗尽
      // (「turn did not settle within 900000ms」)就成了主进程的未处理 Promise 拒绝(#5049 复现时 mac1 实测)。
      void result.completion?.catch((error: unknown) => {
        log.error(
          { agentUserId, trigger, err: error instanceof Error ? error.message : String(error) },
          'provider turn admitted by this pull failed to settle; no redelivery (the cursor already advanced)',
        )
      })
    },
    (error: unknown) => {
      log.error(
        { agentUserId, trigger, err: error instanceof Error ? error.message : String(error) },
        'agent inbox pull failed; unread stays in the cloud cursor and a retry is scheduled',
      )
    },
  )
}

/**
 * 变异对照专用(P-E7 ①):绕过 coalescing single-flight 的裸 pull。生产代码永不调用 —— 它存在的
 * 唯一理由是让「摘掉 single-flight ⇒ 并发双注入」这条必失败对照可以被构造并保持红。
 */
export function __pullOnceUnguardedForTests(
  agentUserId: string,
  deps: AgentInboxReaderDeps,
): Promise<AgentInboxPullResult> {
  return pullOnce(agentUserId, deps)
}

async function refusesArchivedRow(agentUserId: string, row: AgentInboxUnreadRow, state: SessionArchivalState | null, deps: AgentInboxReaderDeps): Promise<boolean> {
  return Boolean(await deps.sessionMessageRefused?.(agentUserId, row.id, row.createdAt)) || sessionArchiveRefusesMessage(state, row.createdAt)
}

async function filterArchivedRows(agentUserId: string, rows: AgentInboxUnreadRow[], state: SessionArchivalState | null, deps: AgentInboxReaderDeps): Promise<AgentInboxUnreadRow[]> {
  const refused = await Promise.all(rows.map((row) => refusesArchivedRow(agentUserId, row, state, deps)))
  return rows.filter((_, index) => !refused[index])
}

async function unclaimedRows(agentUserId: string, rows: AgentInboxUnreadRow[], deps: AgentInboxReaderDeps): Promise<{ rows: AgentInboxUnreadRow[]; queuedAhead: boolean }> {
  if (!deps.claimedSources || rows.length === 0) return { rows, queuedAhead: false }
  const claimed = await deps.claimedSources(agentUserId, rows.map((row) => row.id))
  return { rows: rows.filter((row) => !claimed.has(row.id)), queuedAhead: claimed.size > 0 }
}

async function pullOnce(agentUserId: string, deps: AgentInboxReaderDeps): Promise<AgentInboxPullResult> {
  if (deps.recipientIsRegistered && !(await deps.recipientIsRegistered(agentUserId))) return { pulled: 0, injected: 0, verdict: 'not-now' }
  if ((await deps.sessionArchival?.(agentUserId))?.archivedAt) return { pulled: 0, injected: 0, verdict: 'not-now' }
  const fetchUnread = deps.fetchUnread ?? ((input: AgentInboxFetchInput) =>
    fetchUnreadViaRpc(input, deps.accessToken))
  const localRows = deps.fetchLocalUnread ? await deps.fetchLocalUnread(agentUserId) : []

  let pulled = 0
  let injectedTotal = 0
  let verdict: AgentInboxPullResult['verdict'] = 'idle'
  const completions: Promise<void>[] = []
  let scanAfter: AgentInboxFetchInput['scanAfter']
  let scanFence: number | undefined
  for (;;) {
    const readStartedAt = Date.now()
    const fetchedRows = await fetchUnread({ agentUserId, limit: PULL_LIMIT, scanAfter, scanFence })
    log.debug({ agentUserId, elapsedMs: Date.now() - readStartedAt, rows: fetchedRows.length }, 'agent inbox cloud read completed')
    // Pagination follows cloud rows, not local outbox positions. Every cloud row is already one the
    // RPC decided to hand this agent (chat.message_wakes_agent); the reader adds no eligibility of its own.
    // This cursor is discarded on every exit (including failure); the next trigger starts
    // from authoritative unread rows, including new messages behind this scan's cursor.
    const rawRows = scanAfter ? fetchedRows : [...fetchedRows, ...localRows]
    pulled += rawRows.length
    if (rawRows.length === 0) break
    const archival = await deps.sessionArchival?.(agentUserId) ?? null
    if (archival?.archivedAt) { verdict = 'not-now'; break }
    const unclaimed = await unclaimedRows(agentUserId, await filterArchivedRows(agentUserId, rawRows, archival, deps), deps)
    const batchResult = await injectBatch(agentUserId, unclaimed.rows, deps, unclaimed.queuedAhead)
    injectedTotal += batchResult.injected
    verdict = batchResult.verdict
    if (batchResult.completion) completions.push(batchResult.completion)
    // not-live / not-now:游标不动,本轮结束,等下一个触发(唤醒完成/回合末)。
    if (batchResult.verdict !== 'accepted' && batchResult.verdict !== 'enqueued') break
    if (fetchedRows.length < PULL_LIMIT) break
    const tail = fetchedRows[fetchedRows.length - 1]!
    if (scanAfter && (tail.chatId < scanAfter.chatId || (tail.chatId === scanAfter.chatId && tail.seq <= scanAfter.seq))) {
      throw new Error('pull_agent_inbox_v2 scan cursor did not advance')
    }
    scanFence ??= tail.scanFence
    if (scanFence === undefined || !Number.isFinite(scanFence)) {
      throw new Error('pull_agent_inbox_v2 page has no server scan fence')
    }
    scanAfter = { chatId: tail.chatId, seq: tail.seq }
  }
  // 论坛来源:聊天这一轮受理完(或本来就没有)才拉 —— 会话不 live / 此刻不收时它也不收,等下一个触发。
  if (deps.fetchForumUnread && (verdict === 'idle' || verdict === 'accepted' || verdict === 'enqueued')) {
    const forumRows = await deps.fetchForumUnread(agentUserId)
    pulled += forumRows.length
    if (forumRows.length > 0) {
      const archival = await deps.sessionArchival?.(agentUserId) ?? null
      if (archival?.archivedAt) return { pulled, injected: injectedTotal, verdict: 'not-now' }
      const unclaimed = await unclaimedRows(agentUserId, await filterArchivedRows(agentUserId, forumRows, archival, deps), deps)
      const batchResult = await injectBatch(agentUserId, unclaimed.rows, deps, unclaimed.queuedAhead)
      injectedTotal += batchResult.injected
      verdict = batchResult.verdict
      if (batchResult.completion) completions.push(batchResult.completion)
    }
  }
  return {
    pulled,
    injected: injectedTotal,
    verdict,
    ...(completions.length > 0 ? { completion: Promise.all(completions).then(() => undefined) } : {}),
  }
}

/** One row a unit settles once its agent accepts it, with what acceptance records for it. */
export type AgentInboxSource = Pick<PreparedMessage, 'row' | 'rulesDelivered' | 'bootstrapKey'>

type PreparedMessage = {
  row: AgentInboxUnreadRow
  envelope: string
  attachments?: InlineImage[]
  bootstrapKey?: string
  /** 这条投递附上了群规原文(或撤销通知):受理后记为已送达。 */
  rulesDelivered?: { chatId: string; entry: DeliveredGroupRules }
}

type GroupRulesPlan = Map<string, { version: string; text: string | null; contextKey: string | null }>

const ROOM_KINDS = new Set<ChatKind | null>(['group', 'topic'])

/**
 * #3641 这一批里每条群/话题线的群规:现读 → 与已送达记录比对 → 决定要不要附原文。
 * 读失败照常抛(fail loud):批不注入、游标不动,下一个触发重来 —— ❌ 不在没见过群规的情况下照投。
 */
async function planGroupRules(
  agentUserId: string,
  rows: AgentInboxUnreadRow[],
  deps: AgentInboxReaderDeps,
  env: NodeJS.ProcessEnv,
): Promise<GroupRulesPlan> {
  const plan: GroupRulesPlan = new Map()
  const chatIds = [...new Set(rows.filter((row) => !row.localSessionDirect && ROOM_KINDS.has(row.chatKind)).map((row) => row.chatId))]
  if (chatIds.length === 0) return plan
  const readFacts = deps.fetchChatFacts
    ?? ((chatId: string, asUserId: string) => fetchChatFactsViaRpc(chatId, asUserId, deps.accessToken))
  const ledger = deps.groupRulesLedger ?? groupRulesLedgerFor(env)
  const contextKey = (await deps.deliveryContextKey?.(agentUserId)) ?? null
  for (const chatId of chatIds) {
    const rules = await effectiveGroupRules(chatId, (id) => readFacts(id, agentUserId))
    const decision = decideGroupRulesDelivery({ rules, delivered: await ledger.read(agentUserId, chatId), contextKey })
    plan.set(chatId, { ...decision, contextKey })
  }
  return plan
}

type PreparedUnit = {
  text: string
  attachments?: InlineImage[]
  members: PreparedMessage[]
}

/**
 * A chat row whose own identity cannot be written into an envelope: no host can ever deliver it, so retrying
 * it re-fails every pull. Left in the batch it blocked every later message to this agent — a 1040.1 host failed
 * every delivery to one agent for hours on one notice whose id it refused to encode. Only identity
 * shape is judged here; a failure that could pass on retry (such as an identity read) still fails the batch.
 */
function undeliverableRowReason(row: AgentInboxUnreadRow): string | null {
  if (row.localSessionDirect || row.forum) return null
  try {
    encodeTypedId('msg', row.id)
    encodeTypedId('chat', row.chatId)
    if (row.senderUserId) encodeTypedId('user', row.senderUserId)
    if (row.replyToMessageId) encodeTypedId('msg', row.replyToMessageId)
    if (row.replyToSenderUserId) encodeTypedId('user', row.replyToSenderUserId)
    if (row.threadRootId) encodeTypedId('msg', row.threadRootId)
    for (const id of row.toUserIds ?? []) encodeTypedId('user', id)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function injectBatch(
  agentUserId: string,
  pulledRows: AgentInboxUnreadRow[],
  deps: AgentInboxReaderDeps,
  /** Rows an enqueuing host still holds unread were left out of this pull. */
  queuedAhead = false,
): Promise<{ injected: number; verdict: AgentInboxInjectionVerdict; completion?: Promise<void> }> {
  const env = deps.env ?? process.env
  const toolNames = deps.deliveryToolNames?.(agentUserId) ?? undefined
  // An undeliverable row is skipped and logged on its own; the rest of the batch is delivered. It is marked read
  // in chat order with what is delivered after it, since the server cursor never passes an unread message.
  const skipped: PreparedMessage[] = []
  const rows = pulledRows.filter((row) => {
    const reason = undeliverableRowReason(row)
    if (reason === null) return true
    log.error({ agentUserId, chatId: row.chatId, messageId: row.id, seq: row.seq, reason },
      'agent inbox row cannot be delivered by any host; skipped so it no longer blocks later messages')
    skipped.push({ row, envelope: '' })
    return false
  })
  if (rows.length === 0) {
    if (!queuedAhead) await advanceCursor(agentUserId, skipped, deps)
    return { injected: 0, verdict: 'accepted' }
  }
  const rulesPlan = await planGroupRules(agentUserId, rows, deps, env)
  const prepared: PreparedMessage[] = []
  try {
    for (const row of rows) {
      const planned = row.localSessionDirect ? undefined : rulesPlan.get(row.chatId)
      // 原文只随这一批里该线的第一条投递附一次;其余同线投递只带版本号。
      const groupRules = planned && (planned.version !== 'none' || planned.text !== null)
        ? { version: planned.version, text: planned.text }
        : null
      if (planned) planned.text = null
      const message = await prepareMessage(agentUserId, row, deps, toolNames, env, groupRules)
      if (groupRules && groupRules.text !== null) {
        message.rulesDelivered = { chatId: row.chatId, entry: { version: groupRules.version, contextKey: planned!.contextKey } }
      }
      prepared.push(message)
    }
  } catch (error) {
    // Nothing of this batch was admitted yet: a row that cannot be prepared fails the batch the same way an
    // injection does — disclosed to its chats with the error rethrown as it was, ❌ a pull that just stops.
    deps.onOutcome?.({ agentUserId, ok: false })
    throw saidIfDisclosed(error, await discloseBatchFailure(agentUserId, rows.map((row) => ({ row })), deps))
  }
  // Queue-backed (idle-only) rows stay one per admission so the queue can merge at drain. A
  // next-tool-call transport has no queue boundary: the admission itself is the delivery boundary,
  // so merge the rows there with the same core producer. Attachments remain one admission each.
  const timing = await deps.deliveryTiming?.(agentUserId)
  const framed = prepared.filter((entry) => !entry.attachments)
  const mergedText = timing === 'next-tool-call' && framed.length > 0
    ? mergeDeliveryEnvelopes(framed.map((entry) => entry.envelope))
    : null
  let merged = false
  const units: PreparedUnit[] = prepared.flatMap((entry): PreparedUnit[] => {
    if (entry.attachments) {
      return [{ text: entry.envelope, attachments: entry.attachments, members: [entry] }]
    }
    if (mergedText !== null) {
      if (merged) return []
      merged = true
      return [{ text: mergedText, members: framed }]
    }
    return [{ text: entry.envelope, members: [entry] }]
  })
  deps.onBatch?.({ agentUserId, rows: rows.length, units: units.length })
  if (env.GUGU_SESSION_TEST_HOOKS === '1') {
    batchAudit.push({ agentUserId, rows: rows.length, units: units.length })
    if (batchAudit.length > 200) batchAudit.shift()
  }

  let injected = 0
  let enqueued = false
  const completions: Promise<void>[] = []
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex]!
    // Skipped rows this unit passes are settled with it, in chat order (the server cursor never passes an unread row).
    const reach = new Map<string, number>()
    for (const member of unit.members) reach.set(member.row.chatId, Math.max(reach.get(member.row.chatId) ?? -Infinity, member.row.seq))
    const passed = skipped.filter((entry) => entry.row.seq < (reach.get(entry.row.chatId) ?? -Infinity))
    const archival = await deps.sessionArchival?.(agentUserId) ?? null
    if (archival?.archivedAt || (await Promise.all(unit.members.map(({ row }) => refusesArchivedRow(agentUserId, row, archival, deps)))).some(Boolean)) {
      return { injected, verdict: 'not-now', ...(completions.length ? { completion: Promise.all(completions).then(() => undefined) } : {}) }
    }
    let unitVerdict: AgentInboxInjectionVerdict
    let completion: Promise<void> | undefined
    try {
      const result = await deps.inject({
        agentUserId,
        messageId: unit.members[0]!.row.id,
        text: unit.text,
        sources: [...passed, ...unit.members].map(({ row, rulesDelivered, bootstrapKey }) =>
          ({ row, ...(rulesDelivered ? { rulesDelivered } : {}), ...(bootstrapKey ? { bootstrapKey } : {}) })),
        ...(unit.attachments ? { attachments: unit.attachments } : {}),
      })
      if (typeof result === 'string') {
        unitVerdict = result
      } else {
        unitVerdict = result.verdict
        completion = result.completion?.catch(async (error: unknown) => {
          if (isSaidInChat(error)) throw error
          deps.onOutcome?.({ agentUserId, ok: false })
          // Admission already advanced the cursor. Report provider failure here, where the exact
          // source rows are still known, including pulls started without a device command.
          throw saidIfDisclosed(error, await discloseBatchFailure(agentUserId, unit.members, deps, error))
        })
      }
    } catch (error) {
      deps.onOutcome?.({ agentUserId, ok: false })
      // The pull is still the failure disclosure boundary: include this failed unit and every
      // later row that was not admitted, but do not re-report rows already accepted above it.
      const unadmitted = units.slice(unitIndex).flatMap((remaining) => remaining.members)
      throw saidIfDisclosed(error, await discloseBatchFailure(agentUserId, unadmitted, deps))
    }
    if (unitVerdict !== 'accepted' && unitVerdict !== 'enqueued') {
      if (unitVerdict === 'not-live') deps.wake?.(agentUserId)
      return {
        injected,
        verdict: unitVerdict,
        ...(completions.length > 0 ? { completion: Promise.all(completions).then(() => undefined) } : {}),
      }
    }
    injected += unit.members.length
    if (completion) completions.push(completion)
    for (const entry of passed) skipped.splice(skipped.indexOf(entry), 1)
    // Enqueued: the host's queue owns these rows now; acceptance settles them (markInboxRowsRead).
    if (unitVerdict === 'enqueued') enqueued = true
    else await settleAccepted(agentUserId, [...passed, ...unit.members], deps)
  }
  // Behind queued rows (this pull's, or held from an earlier one) a skipped row would pass rows still unread: it waits.
  if (skipped.length > 0 && !enqueued && !queuedAhead) await advanceCursor(agentUserId, skipped, deps)
  return {
    injected,
    verdict: enqueued ? 'enqueued' : 'accepted',
    ...(completions.length > 0 ? { completion: Promise.all(completions).then(() => undefined) } : {}),
  }
}

async function prepareMessage(
  agentUserId: string,
  row: AgentInboxUnreadRow,
  deps: AgentInboxReaderDeps,
  toolNames: AgentDeliveryToolNames | undefined,
  env: NodeJS.ProcessEnv,
  groupRules: { version: string; text: string | null } | null = null,
): Promise<PreparedMessage> {
  if (row.localSessionDirect) {
    return { row, envelope: row.localSessionDirect.envelope }
  }
  if (row.forum) return { row, envelope: row.forum.envelope }
  const identities = new Map<string, GuguIdentity>()
  if (row.senderUserId) {
    identities.set(row.senderUserId, {
      guguNumber: row.senderGuguNumber,
      displayName: row.senderDisplayName,
      isAgent: row.senderType === 'agent',
    })
  }
  // Everyone the envelope names besides the sender: whom it is for, and whose message it quotes (that can be the
  // agent itself, quoted back by its owner) — else the envelope can only give their bare id.
  const namedIds = [...new Set(
    [...(row.toUserIds ?? []), row.replyToSenderUserId].filter((id): id is string => !!id && id !== row.senderUserId && id !== '*'),
  )]
  if (namedIds.length && deps.resolveGuguIds) {
    const named = await deps.resolveGuguIds(namedIds, deps.accessToken)
    for (const [id, identity] of named) identities.set(id, identity)
  }
  // #1531:thread root 消息让 agent 的回复进它自身的 thread。
  const effectiveThreadRoot = row.threadRootId ?? (row.isThreadRoot ? row.id : null)
  let threadContext: string | null = null
  let bootstrapKey: string | undefined
  if (effectiveThreadRoot && deps.fetchThreadMessages) {
    const key = `${agentUserId}:${row.chatId}:${effectiveThreadRoot}`
    if (!threadBootstrapped.has(key)) {
      try {
        const threadRows = await deps.fetchThreadMessages(row.chatId, effectiveThreadRoot)
        const senders = [...new Set(threadRows.map((entry) => entry.senderUserId))]
        const labels = deps.resolveGuguIds
          ? await deps.resolveGuguIds(senders, deps.accessToken).catch((error: unknown) => {
              log.warn({ err: error instanceof Error ? error.message : String(error) }, 'thread-bootstrap identity resolve failed')
              return new Map<string, GuguIdentity>()
            })
          : new Map<string, GuguIdentity>()
        threadContext = buildThreadBootstrapBody(threadRows, {
          selfAgentUserId: agentUserId,
          labelFor: (id) => identityShown(labels, id) ?? encodeTypedId('user', id),
        })
        bootstrapKey = key
      } catch (error) {
        // fail-loud-warn:拉取失败不阻塞投递,不落标记,下次重注 seed。
        log.warn(
          { chatId: row.chatId, threadRootId: effectiveThreadRoot, err: error instanceof Error ? error.message : String(error) },
          'thread-bootstrap fetch failed; delivering without seed',
        )
      }
    }
  }
  const attachment = parseAttachmentContent(row.content, { id: row.id, file_item_id: row.fileItemId, file_version: row.fileVersion, file_blob_id: row.fileBlobId })
  const download = (fileName: string) => attachmentStage({ agentUserId, chatId: row.chatId, messageId: row.id }, 'download', async () => {
    if (!deps.downloadAttachment) throw new Error('Verified attachment reader is not installed')
    return deps.downloadAttachment({ message_id: row.id }, fileName, agentUserId)
  })
  // 条目已删(gone):没有字节可给,正文(名字、大小)照原样交下去。
  let attachments: InlineImage[] | undefined
  let fileLine = ''
  if (attachment?.kind === 'image' && attachment.source.kind !== 'gone') {
    try {
      const image = await download(attachment.fileName)
      attachments = [{ data: Buffer.from(image.bytes).toString('base64'), mimeType: attachment.mimeType, fileName: attachment.fileName, localPath: image.localPath }]
    } catch (error) {
      fileLine = `\n[Image not saved: ${attachmentFailureReason(error)}]`
    }
  }
  // 新式附件的文件(不是图):正文里没有链接(老附件靠正文里的 [URL] 去取),字节和图片一样下到本机,交本地路径。
  // 下不下来(签不到、CDN 回错、超时)就照实说没存下和原因 —— 这一行和同一批的别的行照样交,不卡住收件。
  if (attachment?.kind === 'file' && attachment.source.kind !== 'gone' && attachment.source.kind !== 'url') {
    try {
      fileLine = `\n[File saved at local path: ${(await download(attachment.fileName)).localPath}]`
    } catch (error) {
      fileLine = `\n[File not saved: ${attachmentFailureReason(error)}]`
    }
  }
  const folderLine = attachment?.source.kind === 'item' ? `\n${attachmentFolderLine(attachment.source.itemId, attachment.source.version)}` : ''
  const content = attachments && attachment
    ? `${attachment.caption || `[Image attached: ${attachment.fileName}]`}${folderLine}${attachments?.[0]?.localPath ? `\n[Image attached at local path: ${attachments[0].localPath}]` : ''}`
    : `${row.content}${folderLine}${fileLine}`
  const messageContext = buildAgentMentionContext(content, row.toUserIds, identities, agentUserId)
  const envelope = buildAgentDeliveryEnvelope(
    {
      guguUserId: agentUserId,
      chatId: row.chatId,
      messageId: row.id,
      senderUserId: row.senderUserId,
      contentType: row.contentType,
      content,
      replyTo: row.replyToMessageId && row.replyToSenderUserId
        ? { messageId: row.replyToMessageId, senderUserId: row.replyToSenderUserId, content: row.replyToContent ?? '' }
        : null,
      threadRootId: effectiveThreadRoot,
      whisperTo: row.isWhisper ? row.toUserIds : null,
      viaApp: row.viaApp ?? null,
    },
    identities,
    { publicId: row.chatPublicId, name: row.chatName, kind: row.chatKind },
    formatDeliveryTimestamp(row.createdAt),
    null,
    toolNames,
    { listenMode: resolveListenModeDefault(row.listenMode), messageContext, groupRules },
  )
  return {
    row,
    envelope: threadContext
      ? rebuildEnvelopeWithThreadContext(agentUserId, row, content, identities, toolNames, threadContext, messageContext, groupRules)
      : envelope,
    ...(attachments ? { attachments } : {}),
    ...(bootstrapKey ? { bootstrapKey } : {}),
  }
}

function rebuildEnvelopeWithThreadContext(
  agentUserId: string,
  row: AgentInboxUnreadRow,
  content: string,
  identities: Map<string, GuguIdentity>,
  toolNames: AgentDeliveryToolNames | undefined,
  threadContext: string,
  messageContext: string | undefined,
  groupRules: { version: string; text: string | null } | null,
): string {
  return buildAgentDeliveryEnvelope(
    {
      guguUserId: agentUserId,
      chatId: row.chatId,
      messageId: row.id,
      senderUserId: row.senderUserId,
      contentType: row.contentType,
      content,
      replyTo: row.replyToMessageId && row.replyToSenderUserId
        ? { messageId: row.replyToMessageId, senderUserId: row.replyToSenderUserId, content: row.replyToContent ?? '' }
        : null,
      threadRootId: row.threadRootId ?? (row.isThreadRoot ? row.id : null),
      whisperTo: row.isWhisper ? row.toUserIds : null,
      viaApp: row.viaApp ?? null,
    },
    identities,
    { publicId: row.chatPublicId, name: row.chatName, kind: row.chatKind },
    formatDeliveryTimestamp(row.createdAt),
    null,
    toolNames,
    { listenMode: resolveListenModeDefault(row.listenMode), threadContext, messageContext, groupRules },
  )
}

/**
 * What an accepted unit records, once: its rows read (in chat order), the group rules it carried delivered, its
 * threads bootstrapped, and the outcome. An injection runs it at admission; an enqueuing host at its agent's acceptance.
 */
async function settleAccepted(agentUserId: string, sources: readonly AgentInboxSource[], deps: AgentInboxReaderDeps): Promise<void> {
  await advanceCursor(agentUserId, sources.map((source) => ({ ...source, envelope: '' })), deps)
  deps.onOutcome?.({ agentUserId, ok: true })
  const ledger = deps.groupRulesLedger ?? groupRulesLedgerFor(deps.env ?? process.env)
  for (const source of sources) {
    if (source.bootstrapKey) threadBootstrapped.add(source.bootstrapKey)
    if (source.rulesDelivered) await ledger.write(agentUserId, source.rulesDelivered.chatId, source.rulesDelivered.entry)
  }
}

/** An enqueuing host's agent accepted these rows: settle them exactly as an accepted injection does. */
export function markInboxRowsRead(agentUserId: string, sources: readonly AgentInboxSource[], deps: AgentInboxReaderDeps): Promise<void> {
  return settleAccepted(agentUserId, sources, deps)
}

/** An enqueuing host could not deliver these rows: say so in their chats, as a failed injection does. */
export async function discloseInboxRowsFailed(agentUserId: string, sources: readonly AgentInboxSource[], deps: AgentInboxReaderDeps): Promise<void> {
  deps.onOutcome?.({ agentUserId, ok: false })
  await discloseBatchFailure(agentUserId, sources, deps)
}

/**
 * 游标推进(at-least-once 的「after」支):只推进**这次注入受理过**的行,按每 chat 的 seq 升序;
 * 某一条推进失败就停止该 chat 的后续推进(保序),披露并向触发方抛错;游标保持原位,后续触发会重拉,重复以稳定 id 显形。
 */
async function advanceCursor(
  agentUserId: string,
  members: PreparedMessage[],
  deps: AgentInboxReaderDeps,
): Promise<void> {
  const markRead = deps.markRead
    ?? ((input: AgentDeliveredMessageRead) => markAgentDeliveredMessageRead(input, { accessToken: deps.accessToken }))
  const byChat = new Map<string, PreparedMessage[]>()
  for (const member of members) {
    const list = byChat.get(member.row.chatId) ?? []
    list.push(member)
    byChat.set(member.row.chatId, list)
  }
  for (const [chatId, chatMembers] of byChat) {
    const ordered = [...chatMembers].sort((a, b) => a.row.seq - b.row.seq)
    for (const member of ordered) {
      try {
        if (member.row.forum) {
          const ack = deps.ackForum ?? ((input: { agentUserId: string; postId: string; seq: number }) => ackForumViaRpc(input, deps.accessToken))
          await ack({ agentUserId, postId: member.row.forum.postId, seq: member.row.forum.seq })
        } else if (member.row.localSessionDirect) {
          if (!deps.markLocalRead) throw new Error('local session-direct row has no markLocalRead handler')
          await deps.markLocalRead({
            agentUserId,
            sessionId: member.row.localSessionDirect.sessionId,
            messageId: member.row.id,
          })
        } else {
          await markRead({ chatId, messageId: member.row.id, agentUserId })
        }
      } catch (error) {
        log.error(
          { agentUserId, chatId, messageId: member.row.id, err: error instanceof Error ? error.message : String(error) },
          'cursor advance failed after accepted injection; the tail of this chat will be re-pulled (duplicates stay visible by stable id)',
        )
        // An accepted delivery whose read receipt failed is a user-visible delivery failure, not a
        // recoverable skip. Disclose the affected tail and rethrow so the kick caller observes failure;
        // leaving the cursor untouched is deliberate and keeps the cloud row eligible for a later pull.
        deps.onOutcome?.({ agentUserId, ok: false })
        throw saidIfDisclosed(error, await discloseBatchFailure(agentUserId, chatMembers, deps))
      }
    }
  }
}

/**
 * 批失败披露:按来源 chat 分别落一条 system 行,文案按批如实说(❌ 不伪装成单条失败)。
 * 这一行是写进对话、给对话里所有人(别的成员、别的设备)看的持久记录 ⇒ ❌ 内部编号(owner 10-11 定,#7103):
 * 稳定 id 只进去重键与日志。原因说「咕咕这边出错了」—— 走到这里时手上没有原因码(注入口抛的是
 * 「has no local session-page runtime」这类宿主自己的错),❌ 为它另开一条递原因的通道。
 */
async function discloseBatchFailure(
  agentUserId: string,
  members: readonly Pick<PreparedMessage, 'row'>[],
  deps: AgentInboxReaderDeps,
  completionError?: unknown,
): Promise<boolean> {
  const post = deps.postDisclosure ?? ((input: DisclosureRow) => postDeliveryDisclosureRow(input, deps.accessToken))
  const reason = failureReason(completionError)
  const byChat = new Map<string, Pick<PreparedMessage, 'row'>[]>()
  const byPost = new Set<string>()
  for (const member of members) {
    if (member.row.forum) {
      byPost.add(member.row.forum.postId)
      continue
    }
    if (member.row.localSessionDirect) {
      // 本机投影行没有云端 chat 行可披露(chatId 是 `local-session:<conversationId>` 占位,POST 会被 uuid 列拒);
      // 它的可见面是本机 outbox 的 failed 收据(由 drain 落),这里只把失败记进日志,❌ 不发一个必 400 的请求。
      log.error(
        { agentUserId, sessionId: member.row.localSessionDirect.sessionId, messageId: member.row.id },
        'local session-direct row failed to inject; no cloud chat to disclose into, outbox receipt carries the failure',
      )
      continue
    }
    const list = byChat.get(member.row.chatId) ?? []
    list.push(member)
    byChat.set(member.row.chatId, list)
  }
  // Said only when every chat (and every post) got its row: a batch of local rows alone, or a post that failed, leaves it unsaid.
  let said = byChat.size + byPost.size > 0
  // 论坛来源:失败记在那条指派上(主人在帖子里看到),❌ 写成一条回复。没受理(游标没动、会重投)与受理了但那一轮失败分开记。
  const recordForum = deps.recordForumFailure
    ?? ((input: { agentUserId: string; postId: string; state: ForumDeliveryFailure; error: string }) => recordForumFailureViaRpc(input, deps.accessToken))
  for (const postId of byPost) {
    const state: ForumDeliveryFailure = completionError === undefined ? 'undelivered' : 'turn_failed'
    try {
      await recordForum({ agentUserId, postId, state, error: reason })
    } catch (error) {
      said = false
      log.error(
        { agentUserId, postId, state, err: error instanceof Error ? error.message : String(error) },
        'forum delivery failure could not be recorded on the assignment; this failure remains undisclosed',
      )
    }
  }
  const spokeAfter = deps.agentSpokeAfter ?? ((input: AgentSpokeAfterInput) => agentSpokeAfterViaRpc(input, deps.accessToken))
  for (const [chatId, chatMembers] of byChat) {
    const ids = chatMembers.map((member) => encodeTypedId('msg', member.row.id))
    // The turn failed after the agent already answered on this line (a provider error on the request after its message_send):
    // the chat has the answer, and a 「未能完成」 under it would contradict it. The failure stays in the log, not in the chat.
    if (completionError !== undefined && await answeredBeforeFailure(agentUserId, chatId, chatMembers, spokeAfter)) {
      log.warn({ agentUserId, chatId, messageIds: ids, err: errorText(completionError) },
        'turn failed after the agent replied in the source chat; no failure row posted')
      continue
    }
    // #7685 额度/模型类失败是这位 agent 的状态，不是这段对话的事：❌ 写进聊天(每条新消息都会再失败一次、刷一行,
    // 群里别的成员还会把它读成上下文)。留成「没说」:设备命令记 reply_notice=context,界面在运行条那一排亮状态位。
    if (agentFailureNeedsModelChoice(reason)) {
      said = false
      log.warn({ agentUserId, chatId, messageIds: ids, reason }, 'quota/model turn failure kept out of the chat; shown as the agent state')
      continue
    }
    const key = `turn-failure:batch:${createHash('sha256').update([agentUserId, ...ids].join(',')).digest('hex').slice(0, 32)}`
    try {
      await post({ agentUserId, chatId, threadRootId: chatMembers[0]!.row.threadRootId, key, reason,
        replyToMessageId: chatMembers.at(-1)!.row.id })
      log.warn({ agentUserId, chatId, messageIds: ids, key }, 'turn-failure disclosed to the source chat')
    } catch (error) {
      said = false
      log.error(
        { agentUserId, chatId, err: error instanceof Error ? error.message : String(error) },
        'turn-failure disclosure post failed; this failure remains undisclosed',
      )
    }
  }
  return said
}

async function answeredBeforeFailure(
  agentUserId: string,
  chatId: string,
  members: readonly Pick<PreparedMessage, 'row'>[],
  spokeAfter: (input: AgentSpokeAfterInput) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await spokeAfter({ agentUserId, chatId, threadRootId: members[0]!.row.threadRootId,
      afterSeq: Math.max(...members.map((member) => member.row.seq)) })
  } catch (error) {
    // Not knowing whether it answered is not an answer: the failure is still said.
    log.error({ agentUserId, chatId, err: errorText(error) }, 'could not read whether the agent replied before its turn failed')
    return false
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 失败的原因(聊天里的披露行与论坛指派上的投递状态同一个):没受理是咕咕这边的错;受理后那一轮失败按上游的原因说。 */
function failureReason(completionError: unknown): AgentFailureReason {
  if (completionError === undefined) return 'notAdmitted'
  return agentFailureReason(completionError instanceof Error ? completionError.message : String(completionError)) ?? 'generic'
}

/**
 * 编号 17 (10-12 片场试演): a batch's failure once its row is in the chat (`discloseBatchFailure`) — the host puts up no second
 * notice for it (#7125 同一次失败只说一次): the unread stays on the cloud cursor and the next trigger pulls it again, so a Retry
 * adds nothing, and nothing took that notice down once the agent was back. One per failure, wrapping what was thrown (its
 * message kept): the same error object thrown for two batches is not the same failure (148 评审).
 */
export class SaidInChatError extends Error {
  readonly disclosedInChat = true
  constructor(failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure), { cause: failure })
    this.name = 'SaidInChatError'
  }
}

function saidIfDisclosed(error: unknown, said: boolean): unknown {
  return said ? new SaidInChatError(error) : error
}

/** This turn failure was said in the chat it came from: the host shows nothing more for it. */
export function isSaidInChat(failure: unknown): boolean {
  return failure instanceof SaidInChatError
}
