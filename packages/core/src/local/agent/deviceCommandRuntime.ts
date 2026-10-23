import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
// #4280 —— 信封形状与那句回路提示只有一个属主。本层是设备命令 adapter,不拼壳;壳归 deliveryEnvelope,
// 逐条投递的拼装归读者(agentInboxReader)。
import {
  escapeXmlText,
  type AgentDeliveryToolNames,
  type GuguIdentity,
} from './deliveryEnvelope'
// 这几个名字出现在本层自己的导出签名里(resolveGuguIds / bridge options),
// 所以从这里也读得到。❌ 别把 producer 侧的新名字(renderDeliveryEnvelope / buildSessionDirectEnvelope /
// arrivalHint)也转出去 —— 那会让「壳只有一个属主」在导入路径上重新变得含糊。
export {
  type AgentDeliveryEnvelopeInput,
  type AgentDeliveryToolNames,
  type GuguIdentity,
} from './deliveryEnvelope'
import { getSupabaseAnonKey, getSupabaseUrl } from '../../cloud/config'
import { normalizeAgentType, type AgentType } from '../../agentTypes'
import type { AgentActivityStatus } from '../../shared/types/chat'
import type { AgentStatusReading } from '../../shared/agentStatus'
import { AGENT_INIT_HELD_TIMEOUT_MS } from '../../shared/enums/deviceModels'
import { getAgent, listAgents, removeAgents, updateAgent, cachedProviderSessionId, type LocalAgentRecord } from '../state/agents'
import { agentOwnerUserId, agentsForOwner } from '../state/agentOwner'
import { normalizeAgentModelSelection, type AgentModelSelection } from './modelAccess'
import { engineIdForAgentType } from '../../shared/agentModelSelection'
import {
  removeAgentRuntimeSession,
  writeAgentRuntimeSession,
} from './agentRuntimeSession'
import {
  postDeliveryDisclosureRow,
  pullAgentInbox,
  type AgentInboxInjectionInput,
  type AgentInboxInjectionResult,
  type AgentInboxDeliveryTiming,
  type AgentInboxPullResult,
  type AgentInboxUnreadRow,
  type AgentInboxReaderDeps,
} from './agentInboxReader'
import { fetchForumUnreadViaRpc, recordForumFailureViaRpc } from './forumInbox'
import type { AgentDeliveredMessageRead } from './deliveredReadMarkers'
import {
  deviceCommandAgentUserId,
  latestClaimerForAgent,
  readDeviceRuntimeInstances,
  RUNTIME_INSTANCE_STALE_MS,
  type DeviceCommandHolding,
  type DeviceCommandTableClient,
  type PendingDeviceCommand,
} from '../../cloud/deviceCommands'
import type { DeviceOperationTimeoutOverrides } from '../../cloud/deviceOperationTimeouts'
import { encodeTypedId } from '../../shared/typedId.mjs'
import type { ThreadMessageRow } from './threadBootstrap'
import { coreLogger } from '../../log'
import { buildAgentDeliveryEnvelope, buildSystemTaskEnvelope, formatDeliveryTimestamp } from './deliveryEnvelope'
import type { ChatKind } from '../../shared/types/chat'

// @@@logging (#2382) - core 侧注入式 logger:宿主(主进程)注入 pino,没人注入就退化 console。
const log = coreLogger('device-command-runtime')

export interface AgentCreateDevicePayload {
  agent_user_id?: unknown
  display_name?: unknown
  agent_type?: unknown
  project_path?: unknown
  greeting_chat_id?: unknown
  special_focus?: unknown
  avatar?: unknown
  initial_prompt?: unknown
  initial_message_id?: unknown
  initial_chat_public_id?: unknown
  initial_chat_kind?: unknown
  /** 创建框里选的模型(#6264);`platform:` 前缀 = 咕咕平台模型。缺席 = 没选。 */
  model?: unknown
  /** 创建框里选的思考强度档位 id(#6264,如 high)。缺席 = 没选。 */
  effort?: unknown
  /** 创建框里选的权限模式(#6264,GuguPermissionMode 值)。缺席 = 没选。 */
  permission_mode?: unknown
  /**
   * #7199 这个 agent 开子 agent 不指定 harness 时用哪个(harness id,如 claude)。缺席 = 没配,子 agent 继承它自己的 harness。
   * 宿主当场核这台机器认不认得这个 harness,不认得就拒建。
   */
  child_harness?: unknown
  /**
   * #7199 建好后系统交给它的第一件事(不是谁发的聊天消息):会话起来就把它当作「咕咕系统交的任务」排进首轮,
   * 它当一轮正常的活干完回到空闲。会话仍是常驻出生(不记首句):这一轮没跑成也不影响它之后正常被唤醒、回私聊。
   * 与 initial_prompt(主人在私聊里说的第一句)互斥:一条 agent.create 只带一个启动输入。
   */
  first_task?: unknown
  /**
   * #7199 搬家:这条 agent.create 是「接过一位已有的助理」(`adopt: true`,从 `adopt_from_device_id` 搬来),不是新生:
   * 库侧保证不带 first_task / 首句,所以这里不发欢迎、不跑初始化 —— 只在这台机器上把会话立起来(文件由客户端先 / 随后拷好)。
   * 这两个字段只用于日志与可观测,不参与分支:行为差别全在「没有启动输入」这一点上。
   */
  adopt?: unknown
  adopt_from_device_id?: unknown
}

/**
 * S2b(pull 收件箱):`agent.deliver` 缩成**无状态幂等叫醒**。payload 仍由 DB 触发器携带消息内容
 * (唤醒的效率过滤那一层没动),但 handler 只认 `agent_user_id`——消息本体由读者按游标从云端重拉,
 * orphan 重派 = 重拉 = 幂等。❌ 不再有 claim token / per-turn context / 去重表 / held-notice 机器。
 */
export interface AgentDeliverDevicePayload {
  agent_user_id?: unknown
  chat_id?: unknown
  message_id?: unknown
  sender_user_id?: unknown
  content?: unknown
  reply_to_message_id?: unknown
  reply_to_sender_user_id?: unknown
  reply_to_content?: unknown
  listen_mode?: unknown
  to_user_ids?: unknown
  is_whisper?: unknown
  thread_root_id?: unknown
  /** 不是聊天来的:`forum` = 论坛帖子上的一件事(没有 chat_id,内容由读者从帖内事件序列拉)。 */
  source?: unknown
  post_id?: unknown
}

export interface AgentStopDevicePayload {
  agent_user_id?: unknown
}

/**
 * #7199 `agent.retire`:这个 agent 搬去了别的设备(个人助理升降级 / 换电脑)—— 旧家这台把它的**运行时**拆掉:
 * 停会话、删会话行、撤它排的已安排、清本机花名册与缓存。❌ 删文件(工作目录、记忆都留着:搬坏了还有退路,「清除旧家」另做)。
 * 由云端在目标设备的 agent.create 落定(settle)的同一事务里发给旧设备。
 */
export interface AgentRetireDevicePayload {
  agent_user_id?: unknown
  /** 搬去了哪台(日志与回显用,不参与判断)。 */
  moved_to_device_id?: unknown
  reason?: unknown
}

/** #5276 `agent.set_model`：云端 desired 已写好，这条命令让绑定设备把它变成事实。 */
export interface AgentSetModelDevicePayload {
  agent_user_id?: unknown
  /** 与 `AgentModelSelection` 逐字一致的 JSON（服务端 validate_agent_model_selection 已校过形状）。 */
  selection?: unknown
}

export interface AgentRuntimeStateReport {
  agentUserId: string
  activityStatus: AgentActivityStatus
  runtimeKind: string
  runtimeLabel: string
  // @@@recent-actions (#518) - the agent's SEQUENCE of most-recent tool actions (names only, never
  recentActions: string[] | null
  // @@@last-action-at (#437) - the newest tool-action transcript time (ISO), the agent's REAL last activity.
  lastActionAt?: string | null
}

/**
 * 名册上的一行为什么被删:`owner-change` = 换了登录账号,没记 owner 的老行归属未知、整个拆掉;
 * `cloud-gone` = 云端已经没有这个 agent(#2151 的 gone 守卫,#6938)。
 */
export type AgentRosterRemovalReason = 'owner-change' | 'cloud-gone'

export interface ClearLocalAgentRuntimesOptions {
  env?: NodeJS.ProcessEnv
  runtimeBridge?: AgentRuntimeBridge
  /** Called only after the local roster row has been removed at an owner-switch boundary. */
  onAgentRosterRemoved?: (agent: LocalAgentRecord, reason: AgentRosterRemovalReason) => Promise<void> | void
  /**
   * #4277 边界之后的新 owner。记了这个 owner 的行是它自己的:运行态原样留着(会话可能刚在这次 boot
   * 起来,停掉就是把当前用户的终端打黑),token 文件由随后的 syncAgentRuntimeSessions 刷新。
   */
  ownerUserId?: string | null
}

export interface AgentRuntimeBridge {
  /**
   * 这台机器上还没装这个 agent 时先装上(#6264)。从手机 / 另一台电脑往一台机器上建 agent,
   * 发起方看不到、也替不了那台机器点「安装」;刚装好的咕咕 server 上一个 agent 都没有。
   * 在启动预算(AGENT_INIT_HELD_TIMEOUT_MS)**之外**跑:下载一个 agent 可能要几分钟,不能吃掉握手的余量。
   */
  ensureAgentInstalled?(agentType: AgentType, signal?: AbortSignal): Promise<void>
  /** Create and start a real session-page session for a provisioned local agent. */
  startAgentSession?(input: {
    ownerUserId: string
    deviceId: string
    agentUserId: string
    displayName: string
    agentType: AgentType
    projectPath: string
    chatId: string
    initialText?: string
    initialPrompt?: string
    initialMessageId?: string
    initialChatPublicId?: number | null
    initialChatKind?: string | null
    senderUserId?: string
    specialFocus?: string | null
    avatar?: string | null
    /** 创建框里选的模型,原样透传给宿主解释(见 AgentCreateDevicePayload.model)。 */
    model?: string | null
    /** 创建框里选的思考强度,原样透传(见 AgentCreateDevicePayload.effort)。 */
    effort?: string | null
    /** 创建框里选的权限模式,宿主按这家 agent 的能力校验(见 AgentCreateDevicePayload.permission_mode)。 */
    permissionMode?: string | null
    /** 子 agent 默认 harness,宿主核过认得再记到这个 agent 名下(见 AgentCreateDevicePayload.child_harness)。 */
    childHarness?: string | null
    /** Host-owned cancellation for the bounded agent.create startup window. */
    signal: AbortSignal
  }): Promise<{
    guguAgentUserId: string
    chatId: string
    created: boolean
    sessionId: string
    projectId: string
  }>
  /** Exact provider-visible names for the transport that owns this agent's injected turns. */
  deliveryToolNames?(agentUserId: string): AgentDeliveryToolNames | null
  /** Declared admission tier for the mapped session-page transport. */
  deliveryTiming?(agentUserId: string): AgentInboxDeliveryTiming | null | Promise<AgentInboxDeliveryTiming | null>
  /** #3641 该 agent 此刻的 provider 上下文标识(换新上下文 ⇒ 群规重达);报不出回 null。 */
  deliveryContextKey?(agentUserId: string): string | null | Promise<string | null>
  /**
   * 读者的注入口(conversation 键控权威在 host 侧):把一个已拼好的 provider 输入交给该 agent
   * 真正在跑的控制通道。判决归通道:accepted / not-live(映射在、会话冷)/ not-now(仅兼容
   * 明确的通道原子判决)。queued-only admission 必须由注入口响亮失败,不能推进游标。真基础设施错误照旧 THROW。❌ 无 pty 回落。
   */
  injectAgentInbox?(input: AgentInboxInjectionInput): Promise<AgentInboxInjectionResult>
  /** Local session-direct outbox projected into the common inbox reader. */
  fetchLocalSessionDirectInbox?(agentUserId: string): Promise<AgentInboxUnreadRow[]>
  /** A local session-direct row is acknowledged only after common-reader acceptance. */
  markLocalSessionDirectRead?(input: { agentUserId: string; sessionId: string; messageId: string }): Promise<void>
  /** 冷会话唤醒踢一脚——不 await(收信方开机代价记在收信方头上,#4320)。 */
  wakeAgentSession?(agentUserId: string): void
  /**
   * 启动某会话的 ACP 会话(进程 spawn + 握手 → 上报 online)。
   * @@@2208 - 不再带 greeting 参数:create 不发冷启动问候(方案 B)。身份注入由 session bundle 承载。
   */
  create(input: {
    /** Durable command correlation only; device-local intent decides whether native inheritance is required. */
    provisionId?: string
    ownerUserId?: string
    deviceId?: string
    agentUserId: string
    engineId: string
    cwd: string
    conversationId: string
  }): Promise<void>
  /** 这个 agent 此刻的读数(spec agent-status-vocabulary);null = 这台机器上没有它的状态。 */
  agentStatus?(agentUserId: string): AgentStatusReading | null
  /** Recent provider tool actions owned by the session-page session, if available. */
  recentActionsForAgent?(agentUserId: string): {
    actions: string[]
    lastActionAt: string | null
  } | null | Promise<{
    actions: string[]
    lastActionAt: string | null
  } | null>
  /** 某个 agent 的读数变了。宿主据此立刻发布 presence。返回退订函数。 */
  onAgentStatusChanged?(listener: (agentUserId: string) => void): () => void
  /**
   * #5276 把 Agent 级模型选择落成事实：按目录校验 → 落本地 agent cache（下次 spawn 用）→ 若该 agent
   * 此刻有活会话，按 #5186 三态当场应用（同计费路且适配器认 = 热切；否则重开续上历史；默认档 =
   * 清掉会话记录里的模型后重开）。校验不过、落不下、重开失败一律 throw 原话。
   */
  applyAgentModelSelection?(input: {
    agentUserId: string
    engineId: string | null
    selection: AgentModelSelection
  }): Promise<{ applied: AgentModelSelectionApplied; warning?: string; nativeSession?: AgentModelSelectionNativeSession }>
  /** 停止并清理该 agent 的全部会话 session。 */
  stop(input: { agentUserId: string; engineId: string }): Promise<void>
  /**
   * #7199 搬走:拆掉这个 agent 在这台机器上的运行时(会话、已安排、花名册记录),❌ 删文件。幂等:本来就没有 = `found:false`。
   * 宿主才知道会话行、已安排在哪(会话页的库),所以由它做;core 只管命令的形状与回显。
   */
  retireAgent?(agentUserId: string): Promise<{ found: boolean; schedulesRemoved: number }>
}

export interface AgentRuntimeBridgeOptions {
  runtimeBridge?: AgentRuntimeBridge
  /** Host lifecycle cancellation; never use this as a turn/LLM timeout. */
  signal?: AbortSignal
  reportRuntimeState?: (state: AgentRuntimeStateReport) => Promise<void> | void
  onRuntimeStateReportError?: (error: unknown) => void
}

export type AgentCreateStage =
  | 'received'
  | 'installing-agent'
  | 'starting-session'
  | 'session-started'
  | 'runtime-state-reported'
  | 'failed'

export interface HandleAgentCreateDeviceCommandOptions extends AgentRuntimeBridgeOptions {
  ownerUserId?: string
  deviceId?: string
  /** Owner access token — the first-turn envelope resolves the owner's 昵称/咕咕号 with it (#5048). */
  accessToken?: string
  // @@@gugu-id-envelope — same injection as deliver: the initial prompt's `from` is a producer obligation
  // (spec delivery-envelope); this path used to hand the envelope an empty map, so the owner's own first
  // message rendered as `user:<uuid>` on the session page.
  resolveGuguIds?: (
    userIds: Array<string | undefined>,
    accessToken: string | undefined
  ) => Promise<Map<string, GuguIdentity>>
  /** Test-only override for the same bounded startup budget. */
  agentCreateTimeoutMs?: number
  onAgentCreateStage?: (stage: AgentCreateStage) => void
}

export interface HandleAgentDeliverDeviceCommandOptions {
  accessToken?: string
  refreshToken?: string | null
  /** Local session-page runtime bridge. */
  runtimeBridge?: AgentRuntimeBridge
  /** must-reply 违约判定与披露的可见域锚(owner-token 只看得见 owner 在场的会话)。 */
  ownerUserId?: string
  signal?: AbortSignal
  reportRuntimeState?: (state: AgentRuntimeStateReport) => Promise<void> | void
  onRuntimeStateReportError?: (error: unknown) => void
  // @@@gugu-id-envelope - injected so production resolves sender 咕咕号 + display name (thread bootstrap labels)
  resolveGuguIds?: (
    userIds: Array<string | undefined>,
    accessToken: string | undefined
  ) => Promise<Map<string, GuguIdentity>>
  // @@@delivered-read-eager (#800) - injectable so cursor advance is unit-testable without a live RPC.
  markDeliveredRead?: (input: AgentDeliveredMessageRead) => Promise<void> | void
  // @@@agent-init-held (#1594) - the command's created_at, bounding the transient-infrastructure
  // held-retry window: a transient network failure re-queues (held) only within
  // AGENT_INIT_HELD_TIMEOUT_MS of creation (withinAgentInitHeldWindow), else it lands a terminal failure.
  commandCreatedAt?: string
  // @@@1379 thread bootstrap — host 注入:取某 thread 历史(时间正序),给「首进 thread」注入上下文 seed。
  fetchThreadMessages?: (chatId: string, threadRootId: string) => Promise<ThreadMessageRow[]>
  /** 读者传给灯(#2175)的注入结局;缺省不记。 */
  recordDeliverOutcome?: (outcome: { agentUserId: string; ok: boolean }) => void
  /** Test seam: override the reader (unit tests drive the pull deterministically). */
  pullInbox?: (agentUserId: string, deps: AgentInboxReaderDeps) => Promise<AgentInboxPullResult>
  /** Test seam: extra reader deps overrides (fetchUnread/markRead/…). */
  readerDeps?: Partial<AgentInboxReaderDeps>
}

/** 设备把选择落成事实的三种结局 —— 与会话页内 `planModelSwitch` 同一套词，❌ 不另造。 */
export type AgentModelSelectionApplied = 'hot' | 'reload' | 'next-session'

/**
 * #6247 `reload` 之后 harness 自己那条原生会话的去向 —— 重开**实际**拿回来的 session id 说了算。
 * `preserved` = 同一条接回来了(harness 的上下文在);`replaced` = 插件声明 `sourceChangeSession=replace`、
 * 换计费路时起了新的原生会话(咕咕的对话记录仍在)。可选:旧设备不带这一格,读者给中性文案,❌ 猜。
 */
export type AgentModelSelectionNativeSession = 'preserved' | 'replaced'

export interface HandleAgentSetModelDeviceCommandOptions {
  /** Local session-page runtime bridge；缺 `applyAgentModelSelection` 即 fail loud（没有谁能把选择变成事实）。 */
  runtimeBridge?: AgentRuntimeBridge
  /**
   * 回写云端 applied / apply_error（RPC report_agent_model_selection）。
   * 成功与失败都回报：手机那侧读的是这一份，❌ 不让「设备已经拒了」在云里长得像「还在等」。
   */
  reportModelSelection?: (report: {
    agentUserId: string
    applied: AgentModelSelection | null
    error: string | null
  }) => Promise<void> | void
}

export interface HandleAgentRetireDeviceCommandOptions {
  runtimeBridge?: AgentRuntimeBridge
}

export interface AgentRetireDeviceCommandResult {
  retired: true
  gugu_user_id: string
  /** 这台机器上本来就没有它(重放 / 已经拆过)= false。 */
  found: boolean
  schedules_removed: number
  moved_to_device_id: string | null
}

export interface HandleAgentStopDeviceCommandOptions {
  /** Local session-page runtime bridge. */
  runtimeBridge?: AgentRuntimeBridge
  reportRuntimeState?: (state: AgentRuntimeStateReport) => Promise<void> | void
  onRuntimeStateReportError?: (error: unknown) => void
}

export interface AgentCreateDeviceCommandResult {
  gugu_user_id: string
  chat_id: string
  agent_type: AgentType
  project_path: string
  created: boolean
}

/** nudge 的完成 = 读者跑过一轮(拉了什么、注入了多少都如实带回,可对账)。 */
export interface AgentDeliverDeviceCommandResult {
  delivered: true
  gugu_user_id: string
  chat_id: string
  message_id: string
  pulled: number
  injected: number
  verdict: 'idle' | 'accepted' | 'not-live' | 'not-now'
  /** Provider turn completion is intentionally settled outside the device-command tick. */
  completion?: Promise<void>
}

// @@@held-requeue - the handler returns this (instead of completing) when the command should be retried
// on a later tick: a transient infrastructure failure within the bounded window. The dispatcher resets
// the command to 'pending' so it re-fetches next tick; 重派 = 重拉 = 幂等。
export interface AgentDeliverCommandHeldResult {
  delivered: false
  held: true
  reason: string
}

export interface AgentDeliverCommandSkippedResult {
  delivered: false
  held: false
  skipped: true
  reason: string
}

export interface AgentSetModelDeviceCommandResult {
  gugu_user_id: string
  selection: AgentModelSelection
  applied: AgentModelSelectionApplied
  /** 只在 `applied: 'reload'` 时出现;见 `AgentModelSelectionNativeSession`。 */
  nativeSession?: AgentModelSelectionNativeSession
  /** 应用成功但有一件用户必须知道的事（目前只有：重开后历史没能续上）。 */
  warning?: string
}

export interface AgentStopDeviceCommandResult {
  stopped: true
  gugu_user_id: string
  runtime_type?: 'powershell'
  target_id?: string
  container_ref?: string
}

// #1099 / #966: handleAgentWakeDeviceCommand 已删 —— ACP 下无「唤醒」命令(设备在线即可触达);
// S2b 后 deliver 本身就是叫醒。

// #5048 首句信封的 `from`:有 token 有解析器就解析 owner 的昵称/号;失败只降级为省略 from(warn),❌ 阻塞创建。
async function firstTurnSenderIdentity(
  options: HandleAgentCreateDeviceCommandOptions,
): Promise<Map<string, GuguIdentity>> {
  if (!options.resolveGuguIds || !options.accessToken) return new Map()
  try {
    return await options.resolveGuguIds([options.ownerUserId], options.accessToken)
  } catch (error) {
    log.warn(
      { ownerUserId: options.ownerUserId, err: error instanceof Error ? error.message : String(error) },
      'agent.create first-turn sender identity lookup failed; envelope carries from_id only',
    )
    return new Map()
  }
}

/**
 * 建 agent 时交给它的第一件事(#7199),做成一条可以排进启动队列的投递(`startSessionpageAgentSession` 的 `initialPrompt`):
 * 发信方是咕咕系统,`mode="task"`(要做的事,不是通知)。信封里带两个现场事实 —— 和主人的私聊(workspace__* /
 * message_send 的 chat_id)与主人本人(message_send 的收件人);任务正文只写做什么,❌ 让 agent 自己去 message_conversations 里翻。
 * 云上开通(agent.create 的 first_task)与本机开通共用这一个函数。
 */
export function buildFirstTaskPrompt(input: { task: string; chatId: string; ownerUserId: string; now?: Date }): string {
  return buildSystemTaskEnvelope({
    messageId: randomUUID(),
    content: input.task,
    context: `Your private chat with your owner: chat_id ${input.chatId}. Your owner: ${encodeTypedId('user', input.ownerUserId)}.`,
    at: formatDeliveryTimestamp((input.now ?? new Date()).toISOString()),
  })
}

export async function handleAgentCreateDeviceCommand(
  payload: AgentCreateDevicePayload,
  options: HandleAgentCreateDeviceCommandOptions = {},
  _env: NodeJS.ProcessEnv = process.env,
): Promise<AgentCreateDeviceCommandResult> {
  options.onAgentCreateStage?.('received')
  const agentUserId = requiredText(payload.agent_user_id, 'agent_user_id')
  const displayName = requiredText(payload.display_name, 'display_name')
  const agentType = normalizeAgentType(requiredText(payload.agent_type, 'agent_type'))
  const projectPath = text(payload.project_path)
  const chatId = requiredText(payload.greeting_chat_id, 'greeting_chat_id')
  const startAgentSession = options.runtimeBridge?.startAgentSession
  if (!startAgentSession) {
    throw new Error(`agent.create requires session-page session provisioning for ${agentUserId}`)
  }
  if (!options.ownerUserId?.trim()) throw new Error(`agent.create ${agentUserId} is missing its owner binding`)
  if (!options.deviceId?.trim()) throw new Error(`agent.create ${agentUserId} is missing its device binding`)

  const timeoutMs = options.agentCreateTimeoutMs ?? AGENT_INIT_HELD_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`agent.create startup timeout must be a positive finite number, got ${timeoutMs}`)
  }
  const controller = new AbortController()
  const forwardParentAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardParentAbort()
  else options.signal?.addEventListener('abort', forwardParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    // 装 agent 在启动预算之外:预算从装完才开始计(见 AgentRuntimeBridge.ensureAgentInstalled)。
    if (options.runtimeBridge?.ensureAgentInstalled) {
      options.onAgentCreateStage?.('installing-agent')
      await options.runtimeBridge.ensureAgentInstalled(agentType, controller.signal)
    }
    timer = setTimeout(
      () => controller.abort(new Error(`agent.create session start timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    options.onAgentCreateStage?.('starting-session')
    const initialText = text(payload.initial_prompt)
    const initialMessageId = text(payload.initial_message_id)
    if ((initialText && !initialMessageId) || (!initialText && initialMessageId)) {
      throw new Error('agent.create initial prompt requires both initial_prompt and initial_message_id')
    }
    const firstTask = text(payload.first_task)
    if (firstTask && initialText) {
      throw new Error('agent.create first_task and initial_prompt are mutually exclusive: one agent.create carries one startup input')
    }
    const initialPrompt = firstTask
      ? buildFirstTaskPrompt({ task: firstTask, chatId, ownerUserId: options.ownerUserId! })
      : initialText && initialMessageId
      ? buildAgentDeliveryEnvelope(
          {
            guguUserId: agentUserId,
            chatId,
            messageId: initialMessageId,
            senderUserId: options.ownerUserId!,
            content: initialText,
            replyTo: null,
            threadRootId: null,
          },
          await firstTurnSenderIdentity(options),
          {
            publicId: payload.initial_chat_public_id == null ? null : Number(payload.initial_chat_public_id),
            name: null,
            kind: (text(payload.initial_chat_kind) || 'dm') as ChatKind,
          },
          formatDeliveryTimestamp(new Date().toISOString()),
        )
      : undefined
    const provisioned = await startAgentSession({
      ownerUserId: options.ownerUserId,
      deviceId: options.deviceId,
      agentUserId,
      displayName,
      agentType,
      projectPath,
      chatId,
      // first_task 只进启动队列,不当首句记:没有首句 = 常驻出生(idle),首轮没跑成时下次醒来照常自愈(#7223),
      // ❌ 记成首句会让它变成「首轮没跑完的会话」,既不自愈也只能靠界面「重来」。
      initialText: initialText || undefined,
      initialPrompt,
      initialMessageId: initialMessageId || undefined,
      initialChatPublicId: payload.initial_chat_public_id == null ? null : Number(payload.initial_chat_public_id),
      initialChatKind: text(payload.initial_chat_kind) || null,
      senderUserId: options.ownerUserId,
      specialFocus: text(payload.special_focus) || null,
      avatar: text(payload.avatar) || null,
      model: text(payload.model) || null,
      effort: text(payload.effort) || null,
      permissionMode: text(payload.permission_mode) || null,
      childHarness: text(payload.child_harness) || null,
      signal: controller.signal,
    })
    options.onAgentCreateStage?.('session-started')
    await reportAgentRuntimeState(
      {
        agentUserId,
        activityStatus: 'idle',
        runtimeKind: 'gugu',
        runtimeLabel: hostname(),
        recentActions: null,
      },
      options,
    )
    options.onAgentCreateStage?.('runtime-state-reported')
    return {
      gugu_user_id: provisioned.guguAgentUserId,
      chat_id: provisioned.chatId,
      agent_type: agentType,
      project_path: projectPath,
      created: provisioned.created,
    }
  } catch (error) {
    options.onAgentCreateStage?.('failed')
    await reportAgentRuntimeState(
      {
        agentUserId,
        activityStatus: 'idle',
        runtimeKind: 'gugu',
        runtimeLabel: hostname(),
        recentActions: null,
      },
      options,
    )
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardParentAbort)
  }
}

function transientNetworkErrorCode(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null | undefined)?.code
  if (typeof direct === 'string' && direct) return direct
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)?.cause
  return typeof cause?.code === 'string' && cause.code ? cause.code : null
}

function isTransientNetworkError(err: unknown): boolean {
  const code = transientNetworkErrorCode(err)
  if (code && /^(?:EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/i.test(code)) {
    return true
  }
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\bconnection (?:reset|refused|timed out)\b/i.test(message)
}

// 自命令创建起是否仍在「容许重试」窗口内(held 把命令 requeue 到 pending,created_at 不变 → now-created
// 随重试增长,超时即不再 held、落终态)。无 created_at 时保守允许重试(由 orphan 回收 + tick 节流兜底)。
function withinAgentInitHeldWindow(commandCreatedAt: string | undefined, now: number): boolean {
  if (!commandCreatedAt) return true
  const created = Date.parse(commandCreatedAt)
  if (Number.isNaN(created)) return true
  return now - created < AGENT_INIT_HELD_TIMEOUT_MS
}

/**
 * S2b:nudge handler。确保 live(踢一脚,不等)→ 读者拉一批 → 推游标 → done。
 *
 * 无状态、幂等:不携带 claim token / context;orphan 重派 = 重拉(游标挡重复注入)。
 * 消息本体不从 payload 读——云端 chat.messages + 游标才是真源,崩溃/重启由触发④(开机扫)兜底。
 * 瞬态基础设施失败(网络)在有界窗口内 held requeue;真失败落终态 error(读者已按批披露)。
 */
export async function handleAgentDeliverDeviceCommand(
  payload: AgentDeliverDevicePayload,
  options: HandleAgentDeliverDeviceCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentDeliverDeviceCommandResult | AgentDeliverCommandHeldResult | AgentDeliverCommandSkippedResult> {
  const guguUserId = requiredText(payload.agent_user_id, 'agent_user_id')
  const chatId = text(payload.chat_id)
  const messageId = text(payload.message_id)
  if (!options.accessToken) {
    throw new Error('agent.deliver nudge requires a fresh owner access token')
  }
  if (!(await getAgent({ guguUserId }, env))) {
    // #5041 — 队列按持有判据只把本实例持有、或没有任何活着的实例持有(持有预算已尽)的命令交到这里;拿到一条名册里没有的
    // agent = 这台设备上没有运行中的实例持有它(典型:它所在的咕咕窗口已关闭)。终态必须对用户显形——先向来源 chat 落一条
    // 稳定 id 的 system 披露,再 fail loud 落 error,并在错误上标记「已显形」,宿主据此不再叠第二层通用失败提示。
    const disclosed = text(payload.source) === 'forum'
      ? await discloseForumUndeliverable({ agentUserId: guguUserId, postId: text(payload.post_id) }, options)
      : await discloseUndeliverable(
        { agentUserId: guguUserId, chatId, messageId, threadRootId: text(payload.thread_root_id) || null },
        options,
      )
    throw new UndeliverableAgentCommandError(guguUserId, disclosed)
  }
  const runtimeBridge = options.runtimeBridge
  if (!runtimeBridge?.injectAgentInbox) {
    throw new Error(`Session-page runtime unavailable for agent ${guguUserId}`)
  }
  const deps = agentInboxDepsFromBridge({
    accessToken: options.accessToken,
    ownerUserId: options.ownerUserId,
    env,
    runtimeBridge,
    fetchThreadMessages: options.fetchThreadMessages,
    resolveGuguIds: options.resolveGuguIds,
    markDeliveredRead: options.markDeliveredRead,
    recordDeliverOutcome: options.recordDeliverOutcome,
    overrides: options.readerDeps,
  })
  try {
    const pull = options.pullInbox ?? pullAgentInbox
    const result = await pull(guguUserId, deps)
    if (result.verdict === 'not-live') {
      // 读者已踢唤醒;债在云端(游标滞后可观测),会话 live 后由唤醒完成/回合末触发接续。命令即完成。
      log.info({ agentUserId: guguUserId, chatId, pulled: result.pulled }, 'nudge: session not live; wake kicked, unread stays on the cloud cursor')
    }
    return {
      delivered: true,
      gugu_user_id: guguUserId,
      chat_id: chatId,
      message_id: messageId,
      pulled: result.pulled,
      injected: result.injected,
      verdict: result.verdict as AgentDeliverDeviceCommandResult['verdict'],
      ...(result.completion ? { completion: result.completion } : {}),
    }
  } catch (err) {
    if (isTransientNetworkError(err) && withinAgentInitHeldWindow(options.commandCreatedAt, Date.now())) {
      log.warn(
        { agentUserId: guguUserId, chatId, errorCode: transientNetworkErrorCode(err) },
        'nudge pull hit transient transport failure; holding for bounded replay',
      )
      return { delivered: false, held: true, reason: 'command_transport_unavailable:pull' }
    }
    throw err
  }
}

/** 把 host bridge + tick 材料装配成读者 deps(nudge 与 main 的触发③④共用同一装配)。 */
export function agentInboxDepsFromBridge(input: {
  accessToken: string
  ownerUserId?: string
  env?: NodeJS.ProcessEnv
  runtimeBridge: AgentRuntimeBridge
  fetchThreadMessages?: (chatId: string, threadRootId: string) => Promise<ThreadMessageRow[]>
  resolveGuguIds?: (
    userIds: Array<string | undefined>,
    accessToken: string | undefined,
  ) => Promise<Map<string, GuguIdentity>>
  markDeliveredRead?: (read: AgentDeliveredMessageRead) => Promise<void> | void
  recordDeliverOutcome?: (outcome: { agentUserId: string; ok: boolean }) => void
  overrides?: Partial<AgentInboxReaderDeps>
}): AgentInboxReaderDeps {
  const bridge = input.runtimeBridge
  if (!bridge.injectAgentInbox) {
    throw new Error('agent inbox reader requires an injection-capable bridge')
  }
  return {
    accessToken: input.accessToken,
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.env ? { env: input.env } : {}),
    inject: (injection) => bridge.injectAgentInbox!(injection),
    // 论坛来源:被指派到帖子上的事,与聊天同一个读者、同一批触发。
    fetchForumUnread: (agentUserId: string) => fetchForumUnreadViaRpc(agentUserId, input.accessToken),
    ...(bridge.fetchLocalSessionDirectInbox
      ? { fetchLocalUnread: (agentUserId: string) => bridge.fetchLocalSessionDirectInbox!(agentUserId) }
      : {}),
    ...(bridge.markLocalSessionDirectRead
      ? { markLocalRead: (input: { agentUserId: string; sessionId: string; messageId: string }) => bridge.markLocalSessionDirectRead!(input) }
      : {}),
    ...(bridge.wakeAgentSession ? { wake: (agentUserId: string) => bridge.wakeAgentSession!(agentUserId) } : {}),
    ...(bridge.deliveryToolNames
      ? { deliveryToolNames: (agentUserId: string) => bridge.deliveryToolNames!(agentUserId) }
      : {}),
    ...(bridge.deliveryTiming
      ? { deliveryTiming: (agentUserId: string) => bridge.deliveryTiming!(agentUserId) }
      : {}),
    ...(bridge.deliveryContextKey
      ? { deliveryContextKey: (agentUserId: string) => bridge.deliveryContextKey!(agentUserId) }
      : {}),
    ...(input.fetchThreadMessages ? { fetchThreadMessages: input.fetchThreadMessages } : {}),
    ...(input.resolveGuguIds ? { resolveGuguIds: input.resolveGuguIds } : {}),
    ...(input.markDeliveredRead
      ? { markRead: async (read: AgentDeliveredMessageRead) => { await input.markDeliveredRead!(read) } }
      : {}),
    ...(input.recordDeliverOutcome ? { onOutcome: input.recordDeliverOutcome } : {}),
    ...input.overrides,
  }
}

export async function handleAgentStopDeviceCommand(
  payload: AgentStopDevicePayload,
  options: HandleAgentStopDeviceCommandOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentStopDeviceCommandResult> {
  const guguUserId = requiredText(payload.agent_user_id, 'agent_user_id')
  const agent = await findLocalAgentByGuguUserId(guguUserId, env)
  // Stop the session-page owner for this provider, then clear local runtime state.
  const acpStopEngineId = engineIdForAgentType(agent.agent_type)
  if (options.runtimeBridge && acpStopEngineId) {
    await options.runtimeBridge.stop({ agentUserId: guguUserId, engineId: acpStopEngineId })
  }
  // 下线只清引擎运行句柄。会话 / 项目 / 主人绑定与模型选择是持久状态,清掉后
  // 搬家末尾的「下线再上线」会让助理失去寻址、任务与定时都找不到自己的会话(#7199)。
  // 停引擎可能已经更新过名册,这里重新读取,不把 stop 之前的快照写回去。
  const current = await findLocalAgentByGuguUserId(guguUserId, env)
  const cache = { ...(current.cache ?? {}) }
  delete cache.provider_session_id
  delete cache.provider_pid
  await updateAgent({ guguUserId }, {
    cache: Object.keys(cache).length ? cache : null,
    terminal_container: null,
  }, env)
  await reportAgentRuntimeState(
    {
      agentUserId: guguUserId,
      activityStatus: 'idle',
      runtimeKind: 'gugu',
      runtimeLabel: hostname(),
      recentActions: null,
    },
    options
  )
  return {
    stopped: true,
    gugu_user_id: guguUserId,
  }
}

/**
 * #7199 `agent.retire`(见 AgentRetireDevicePayload)。没接上宿主那一格 = 响亮失败:命令落 error,❌ 说「已拆」其实没拆。
 */
export async function handleAgentRetireDeviceCommand(
  payload: AgentRetireDevicePayload,
  options: HandleAgentRetireDeviceCommandOptions = {},
  _env: NodeJS.ProcessEnv = process.env
): Promise<AgentRetireDeviceCommandResult> {
  const guguUserId = requiredText(payload.agent_user_id, 'agent_user_id')
  const retire = options.runtimeBridge?.retireAgent
  if (!retire) throw new Error(`agent.retire requires the session-page host to retire ${guguUserId}`)
  const outcome = await retire.call(options.runtimeBridge, guguUserId)
  return {
    retired: true,
    gugu_user_id: guguUserId,
    found: outcome.found,
    schedules_removed: outcome.schedulesRemoved,
    moved_to_device_id: text(payload.moved_to_device_id) || null,
  }
}

/**
 * #5276 `agent.set_model`：把云端已写好的 desired 落成这台设备上的事实。
 *
 * 形状与 `agent.stop` 同构（本地 agent 必须在册；运行时经 bridge），差别在**结局要回写云端**：
 * 手机那侧读的是 `agent_model_selections.applied / apply_error`，命令自己的 done/error 只有发命令的
 * 那个客户端在等。成功回报 applied；失败回报原话再 rethrow —— 命令落 error、云里也写上为什么。
 */
export async function handleAgentSetModelDeviceCommand(
  payload: AgentSetModelDevicePayload,
  options: HandleAgentSetModelDeviceCommandOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentSetModelDeviceCommandResult> {
  const guguUserId = requiredText(payload.agent_user_id, 'agent_user_id')
  if (!payload.selection || typeof payload.selection !== 'object') {
    throw new Error('agent.set_model requires a selection object')
  }
  const selection = normalizeAgentModelSelection(payload.selection)
  const requestedSource = (payload.selection as { source?: unknown }).source
  // normalize 会把坏形状静默折成 default —— 那对「读旧 cache」是对的，对「执行一条命令」是把用户
  // 要的 X 换成了 Y。这里要求形状与来意一致，否则响亮拒。
  if (selection.source !== requestedSource) {
    throw new Error(`agent.set_model selection is malformed: ${JSON.stringify(payload.selection)}`)
  }
  const report = async (applied: AgentModelSelection | null, error: string | null) => {
    if (!options.reportModelSelection) return
    try {
      await options.reportModelSelection({ agentUserId: guguUserId, applied, error })
    } catch (cause) {
      // 回报失败不该反过来把已生效的应用报成失败；但也不能静默 —— 它是手机那侧唯一的读数。
      log.error({ agentUserId: guguUserId, err: cause instanceof Error ? cause.message : String(cause) },
        'agent.set_model: report_agent_model_selection failed')
    }
  }
  try {
    const agent = await findLocalAgentByGuguUserId(guguUserId, env)
    const bridge = options.runtimeBridge
    if (!bridge?.applyAgentModelSelection) {
      throw new Error('agent.set_model requires a runtime bridge that can apply a model selection')
    }
    const outcome = await bridge.applyAgentModelSelection({
      agentUserId: guguUserId,
      engineId: engineIdForAgentType(agent.agent_type),
      selection,
    })
    await report(selection, null)
    return {
      gugu_user_id: guguUserId,
      selection,
      applied: outcome.applied,
      ...(outcome.nativeSession ? { nativeSession: outcome.nativeSession } : {}),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    }
  } catch (error) {
    await report(null, error instanceof Error ? error.message : String(error))
    throw error
  }
}

// An account switch is a local ownership boundary. Runtime state (processes, token files, activity)
// belongs to the previous owner and goes; roster rows are another matter (#4277 owner 拍板:会话不带
// 账号,agent 归各自的账号):
//   · 记了 owner 的行留下 —— 它的主人回来还要用它,删了就只能再铸一个、云端攒孤儿;本账号的巡扫
//     (标在线 / 发活动 / 刷 token / 下线)按 owner 跳过它,所以它留着也不会被写进新 owner 的 token。
//   · 没记 owner 的老行照旧清掉 —— 归属未知,留下来就是过去那个「把新 owner 的 token 写进旧行」的口子。
export async function clearLocalAgentRuntimesForOwnerChange(
  options: ClearLocalAgentRuntimesOptions = {}
): Promise<void> {
  const env = options.env ?? process.env
  const agents = await listAgents(env, { includeGuests: true })
  const newOwner = options.ownerUserId ?? ''
  for (const agent of agents) {
    const recordedOwner = agentOwnerUserId(agent)
    if (newOwner && recordedOwner === newOwner) continue
    if (agent.gugu_user_id) {
      // 记了 owner 的别家行:只清它的 token / 活动文件,❌ 不 stop —— stop 会按 agent 找到会话把整个
      // 会话 session 拆掉,而会话归设备、此刻可能正被新 owner 用着(真机:boot 时第一个标签页刚拉起
      // 就被这一刀打黑,第二个因为晚一步逃过)。新 owner 的 hydrate 会自己把会话重新供给到自己名下。
      // 没记 owner 的老行归属未知,照旧停、清、删。
      const engineId = engineIdForAgentType(agent.agent_type)
      if (!recordedOwner && options.runtimeBridge && engineId) {
        await options.runtimeBridge.stop({ agentUserId: agent.gugu_user_id, engineId })
      }
      await removeAgentRuntimeSession(agent.gugu_user_id, env)
    }
  }
  for (const agent of await removeAgents((agent) => !agentOwnerUserId(agent), env)) {
    await options.onAgentRosterRemoved?.(agent, 'owner-change')
  }
}

async function reportAgentRuntimeState(
  state: AgentRuntimeStateReport,
  options: {
    reportRuntimeState?: (state: AgentRuntimeStateReport) => Promise<void> | void
    onRuntimeStateReportError?: (error: unknown) => void
  }
): Promise<void> {
  if (!options.reportRuntimeState) return
  try {
    await options.reportRuntimeState(state)
  } catch (error) {
    options.onRuntimeStateReportError?.(error)
  }
}

/** 每一格 tick 清一次过期的 guest 记录(presence 由设备 runtime 按本机读数发布,这里不产任何上报)。 */
export async function pruneStaleGuestRecords(options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const env = options.env ?? process.env
  await pruneDeadGuestRecords(await listAgents(env, { includeGuests: true }), env)
}

// @@@ guest-prune — ACP guests have no terminal surface; liveness is session-id + grace period only.
const GUEST_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000
async function pruneDeadGuestRecords(
  agents: import('../state/agents').LocalAgentRecord[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  const now = Date.now()
  const known = new Set(agents)
  await removeAgents((agent) => {
    if (!known.has(agent)) return false
    if (agent.status !== 'guest' || agent.gugu_user_id) return false
    // 完全没有 session id 的 guest 永远无法被身份解析,直接清掉。
    if (!cachedProviderSessionId(agent.cache)) return true
    // 有 session id 但没有任何 surface —— 只在宽限期过后才清。
    const createdMs = typeof agent.created_at === 'number'
      ? agent.created_at * 1000
      : Date.parse(String(agent.created_at))
    const ageMs = Number.isFinite(createdMs) ? now - createdMs : Number.POSITIVE_INFINITY
    return ageMs > GUEST_GRACE_PERIOD_MS
  }, env)
}

// @@@ runtime-session-resync — see git history for full context.
export async function syncAgentRuntimeSessions(
  options: {
    env?: NodeJS.ProcessEnv
    accessToken?: string | null
    refreshToken?: string | null
    /** #4277 这份 token 是谁的:记了别家 owner 的行不写(它们的主人回来时自己会刷)。 */
    ownerUserId?: string | null
  } = {}
): Promise<boolean> {
  const env = options.env ?? process.env
  if (!options.accessToken) return false
  const accessToken = options.accessToken
  const refreshToken = options.refreshToken ?? ''
  const agents = agentsForOwner(await listAgents(env), options.ownerUserId)
  let allWritten = true
  for (const agent of agents) {
    if (!agent.gugu_user_id) continue
    try {
      await writeAgentRuntimeSession(
        { accessToken, refreshToken, agentUserId: agent.gugu_user_id },
        env
      )
    } catch {
      // Best-effort: a single agent's file write failing should not block the
      // rest. Reported as not-all-written so the caller writes the batch again.
      allWritten = false
    }
  }
  return allWritten
}

/**
 * #5041 — 无人持有的 agent 的 deliver 终态。`disclosed` = 来源 chat 已落 system 披露(用户已看见),宿主不再叠通用失败条 /
 * Retry(Retry 只会把同一条再送回同一个「无人持有」)。消息文本保持 `Local agent not found for <id>`(日志与命令 error 列的既有形状)。
 */
export class UndeliverableAgentCommandError extends Error {
  readonly disclosed: boolean
  get disclosedInChat(): boolean { return this.disclosed }
  constructor(agentUserId: string, disclosed: boolean) {
    super(`Local agent not found for ${agentUserId}`)
    this.name = 'UndeliverableAgentCommandError'
    this.disclosed = disclosed
  }
}

export function isDisclosedUndeliverableAgentCommand(failure: unknown): boolean {
  return failure instanceof UndeliverableAgentCommandError && failure.disclosed
}

export interface DeviceCommandHoldingResolverInput {
  client: DeviceCommandTableClient
  deviceId: string
  /** This runtime process (`claimed_by` of the rows it executes). */
  instanceId: string
  env?: NodeJS.ProcessEnv
  operationTimeouts?: DeviceOperationTimeoutOverrides
  /** Clock for sibling liveness (test seam); default = wall clock. */
  nowMs?: () => number
}

/**
 * #5041 — 持有判据,交给 [[command-queue]] 在 claim **之前**问。同账号同机的多个实例共享一个 device_id,而名册(agents.json)是
 * 每个实例自己的,所以「谁持有 agent X」要合两份事实:
 *   · 本机名册有 X → `held`(每 tick 读一次快照;快照没有时再现读一次,同一 tick 里刚 create 出的 X 对随后的 deliver 立即算持有)。
 *   · 名册没有 X → 看 X 的命令**最近由谁执行**(`claimed_by`,#1676 早就记着这个事实):那个实例若不是我、且心跳新鲜
 *     (< RUNTIME_INSTANCE_STALE_MS,与孤儿回收同一阈值)→ `held-elsewhere`,行是它的,不计时;否则 → `unheld`,
 *     队列在持有预算内留着(持有者可能在冷启动),预算尽后 claim 让 handler 落用户可见的终态。
 *   · agent.create 建立持有、没有 agent_user_id 的设备级命令,任一实例可执行 → `held`。
 *   · agent.stop:目标由活着的兄弟持有 → 留给它;否则任一实例立即执行(停一个没人跑的 agent = 收敛云端状态,不必等预算)→ `held`。
 * 兄弟活跃表每个 resolver(= 每 tick)最多读一次;判据抛错由队列按行隔离、响亮记录。
 */
export function createDeviceCommandHoldingResolver(
  input: DeviceCommandHoldingResolverInput,
): (command: Pick<PendingDeviceCommand, 'type' | 'payload'>) => Promise<DeviceCommandHolding> {
  const env = input.env ?? process.env
  const nowMs = input.nowMs ?? (() => Date.now())
  let roster: Promise<Set<string>> | null = null
  let rosterRefreshed = false
  const loadRoster = () => listAgents(env).then((agents) => new Set(agents.map((agent) => agent.gugu_user_id)))
  const rosterHas = async (agentUserId: string): Promise<boolean> => {
    roster ??= loadRoster()
    if ((await roster).has(agentUserId)) return true
    if (rosterRefreshed) return false
    rosterRefreshed = true
    roster = loadRoster()
    return (await roster).has(agentUserId)
  }
  let liveSiblings: Promise<Set<string>> | null = null
  const liveSiblingIds = () => (liveSiblings ??= readDeviceRuntimeInstances(input.client, input.deviceId, input.operationTimeouts)
    .then((instances) => new Set(instances
      .filter((instance) => instance.instanceId !== input.instanceId)
      .filter((instance) => {
        const at = Date.parse(instance.lastHeartbeatAt)
        return !Number.isNaN(at) && nowMs() - at < RUNTIME_INSTANCE_STALE_MS
      })
      .map((instance) => instance.instanceId))))
  return async (command) => {
    if (command.type === 'agent.create') return 'held'
    const agentUserId = deviceCommandAgentUserId(command)
    if (!agentUserId) return 'held'
    if (await rosterHas(agentUserId)) return 'held'
    const claimer = await latestClaimerForAgent(input.client, input.deviceId, agentUserId, input.operationTimeouts)
    if (claimer && claimer !== input.instanceId && (await liveSiblingIds()).has(claimer)) return 'held-elsewhere'
    // 停 / 拆一个没人跑的 agent = 收敛云端状态(幂等),不必等持有预算。
    return command.type === 'agent.stop' || command.type === 'agent.retire' ? 'held' : 'unheld'
  }
}

/**
 * #5041 — 无人持有的 agent 的 deliver 终态显形:来源 chat 里一条稳定 id 的 system 行。返回是否真的落了(披露失败只响亮记日志,
 * 不遮蔽根因)。文案只说可核的事实与修复入口:消息还在云端未读;运行该 agent 的实例上线后由它读取。
 */
/** 论坛来的那一条:没有聊天可落,记在帖子上那条指派的投递状态里(主人在帖子里看到;游标没动,打开那个实例后由它读取)。 */
async function discloseForumUndeliverable(
  input: { agentUserId: string; postId: string },
  options: HandleAgentDeliverDeviceCommandOptions,
): Promise<boolean> {
  const record = options.readerDeps?.recordForumFailure
    ?? ((row: Parameters<typeof recordForumFailureViaRpc>[0]) => recordForumFailureViaRpc(row, options.accessToken!))
  try {
    if (!input.postId) throw new Error('forum agent.deliver carries no post_id')
    await record({
      agentUserId: input.agentUserId,
      postId: input.postId,
      state: 'undelivered',
      error: 'undelivered',
    })
    return true
  } catch (error) {
    log.error(
      { agentUserId: input.agentUserId, postId: input.postId || null, err: error instanceof Error ? error.message : String(error) },
      'undeliverable forum disclosure failed; the command still lands error',
    )
    return false
  }
}

async function discloseUndeliverable(
  input: { agentUserId: string; chatId: string; messageId: string; threadRootId: string | null },
  options: HandleAgentDeliverDeviceCommandOptions,
): Promise<boolean> {
  if (!input.chatId || !input.messageId) {
    log.error(
      { agentUserId: input.agentUserId, chatId: input.chatId || null, messageId: input.messageId || null },
      'undeliverable agent.deliver carries no source chat/message id to disclose into; only the command error records it',
    )
    return false
  }
  const post = options.readerDeps?.postDisclosure
    ?? ((row: Parameters<typeof postDeliveryDisclosureRow>[0]) => postDeliveryDisclosureRow(row, options.accessToken!))
  const key = `undeliverable:${input.agentUserId}:${input.messageId}`
  try {
    await post({ agentUserId: input.agentUserId, chatId: input.chatId, threadRootId: input.threadRootId, key, reason: 'undelivered' })
    return true
  } catch (error) {
    log.error(
      { agentUserId: input.agentUserId, chatId: input.chatId, messageId: input.messageId, err: error instanceof Error ? error.message : String(error) },
      'undeliverable disclosure post failed; the command still lands error',
    )
    return false
  }
}

/** One roster lookup for every handler (strict: two records answering one identity is corrupt data and throws). */
async function findLocalAgentByGuguUserId(
  guguUserId: string,
  env: NodeJS.ProcessEnv
): Promise<LocalAgentRecord> {
  const agent = await getAgent({ guguUserId }, env)
  if (!agent) throw new Error(`Local agent not found for ${guguUserId}`)
  return agent
}

// agent 身份+persona 块:给 agent 一个 IM 身份锚点 + 明确的 IM 行为约束,避免 Claude
// Code 把"发消息"误解成要读记忆、搜工具、跑 shell 兜底。另外,咕咕的用户可见输出必须
// 由 gugu MCP 写入聊天,普通 ACP 文本不是聊天消息。
// @@@identity-block-ssot — 身份+persona 块的唯一模板。session bundle 把它交给 provider 的 system/session-open channel;
// message delivery 不再重复身份块。
// #6490 块里只锚不变的 participant_id,❌ 写显示名:名字会变(本机先猜、云端撞号抬号、owner 改名),而这个块
// 进的是系统提示词 —— 写进去的名字错了就一直错,纠正只能靠一次性推送,推不到的会话(终端、重启过的)永远自认旧名。
// 名字不在上下文里,就没有要纠正的东西:被 @ 时投递信封的 message_context 按 id 标出 `you`
// (buildAgentMentionContext),要知道自己叫什么就调 profile_whoami(读云端当下的名字)。
// 集体记忆对账第 5 条:participant_id 和 agent 别处看到的 id 一个写法 —— `user:<uuid>`(typedId.mjs「进入 agent 提示词的
// id 一律带类型」、F35);比对的字段是 agent 真看得到的:信封的 from_id、message_history 行的 sender_user_id
// (gugu-im-server.mjs 按字段名编码)。❌ 写不存在的 sender_id、❌ 给裸 uuid —— 逐字比对永远对不上。
// 「this session」不写 conversation:owner 10-01 conversation 专指群和私聊,这个块跟着会话走(会话 agent 收所有群的投递)。
export function buildAgentIdentityBlock(input: {
  guguUserId: string
  specialFocus?: string | null
}): string {
  // @@@1390 具体目标 Special Focus:作"它是谁/做什么"的指示注入身份块(创建者填的 agent 专注方向)。
  const focus = input.specialFocus?.trim()
  const focusBlock = focus
    ? `\n<special_focus reason="creator_directive">\n你的具体目标(创建者设定,贯穿你的回应):${escapeXmlText(focus)}\n</special_focus>\n`
    : ''
  return `<agent_identity reason="new_acp_session">
participant_id: ${escapeXmlText(encodeTypedId('user', input.guguUserId))}
You are this 咕咕 participant. Your display name can change while this session runs, so it is not written here: when a message @-mentions you, its message_context marks that mention as you by id; when you need your current name, call profile_whoami.
Messages whose from_id (sender_user_id in message_history) is your participant_id are your own.
Stay in this identity and scope for every reply in this session.
</agent_identity>
${focusBlock}`
}

async function fetchPostgrest<T>(
  path: string,
  accessToken: string,
  profile: string,
  // #4263 评审①:failLoud 让「查询失败」与「行不存在」可分——身份存在性判定(local-direct 闸)
  // 绝不能把 401/5xx/断网塌缩成空结果冒充「身份不存在」。默认仍宽松(装饰用途)。
  opts: { failLoud?: boolean } = {}
): Promise<T[] | null> {
  try {
    const response = await fetch(
      `${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/${path}`,
      {
        headers: {
          apikey: getSupabaseAnonKey(),
          Authorization: `Bearer ${accessToken}`,
          'Accept-Profile': profile,
        }
      }
    )
    if (!response.ok) {
      if (opts.failLoud) throw new Error(`PostgREST ${profile} lookup failed: HTTP ${response.status}`)
      return null
    }
    return (await response.json()) as T[]
  } catch (error) {
    if (opts.failLoud) {
      throw error instanceof Error ? error : new Error(`PostgREST ${profile} lookup failed: ${String(error)}`)
    }
    return null
  }
}

// @@@gugu-id-resolve - best-effort id→咕咕号 lookup for the delivery envelope. identity.users is
export async function resolveGuguIds(
  userIds: Array<string | undefined>,
  accessToken: string | undefined
): Promise<Map<string, GuguIdentity>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id.length > 0))]
  if (ids.length === 0) return new Map()
  // #4263 评审①:map 的成员资格回答「身份行存在吗」,所以查询本身失败必须 loud——空 map 只允许
  // 表示「查了,行不在」。信封装饰调用方在各自现场 catch 成空 map(best-effort 属于它们,不属于这里)。
  if (!accessToken) throw new Error('identity lookup requires an access token')
  const rows = await fetchPostgrest<{
    id: string
    gugu_number: number | null
    display_name: string | null
    type: string | null
  }>(
    // type 一起取:信封要按「发信人是不是 agent」给不同的回复契约(agent 之间收尾用普通消息,❌ 定向)
    `users?select=id,gugu_number,display_name,type&id=in.(${ids.join(',')})`,
    accessToken,
    'identity',
    { failLoud: true }
  )
  if (!rows) throw new Error('identity lookup returned no result set')
  // #4255 —— 不按 gugu_number 过滤:行在 = 身份在。号未分配(null)时展示层落 typed id 锚点。
  return new Map(
    rows.map((row) => [
      row.id,
      {
        // #4263 评审⑥:非 number 非 null 的线上形状变化必须 loud,❌ 静默降级成「未分配」。
        guguNumber: assertGuguNumberShape(row.gugu_number, row.id),
        displayName:
          typeof row.display_name === 'string' && row.display_name.trim().length > 0
            ? row.display_name.trim()
            : null,
        isAgent: row.type === 'agent',
      },
    ])
  )
}

function assertGuguNumberShape(value: unknown, userId: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  throw new Error(`identity.users.gugu_number for ${userId} has unexpected shape: ${typeof value}`)
}

// #5276 `engineIdForAgentType` 搬进 shared/agentModelSelection.ts（纯模块，渲染层也要按 agent_type 推协议）。
export { engineIdForAgentType }

function requiredText(value: unknown, field: string): string {
  const resolved = text(value)
  if (!resolved) throw new Error(`${field} is required`)
  return resolved
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
