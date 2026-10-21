import { AGENT_INIT_HELD_TIMEOUT_MS, isDeviceCommandDone, isDeviceCommandError } from '../shared/enums/deviceModels'
import type { DeviceCommand } from '../shared/types/chat'
import { dbPayload } from './supabase'
import { coreLogger } from '../log'
import { RuntimeAuthExpiredError } from './runtimeAuthProvider'
import {
  resolveDeviceOperationTimeouts,
  runDeviceRequest,
  type DeviceOperationTimeoutOverrides,
} from './deviceOperationTimeouts'

const AGENT_DELIVER_DEVICE_COMMAND = 'agent.deliver'
const log = coreLogger('device-commands')
// #1099/#966: agent.wake 设备命令已退役 —— ACP 下 deliver 懒启会话,无独立唤醒命令。

export interface AgentDeliverDeviceCommandInput {
  userId: string
  deviceId: string
  agentUserId: string
  chatId: string
  messageId: string
  senderUserId: string
  content: string
  // @@@scheduled-tasks (#987 → #2008) - 可选结构化点名直写 payload.to_user_ids：视同
  // @点名，穿透 passive 门。定时任务传 [agentUserId]（原方案钉 listen_mode:'active' 会让 hint 注入
  // 错报档位——active 纪律=每条都答，毒化该 chat 后续注入）。
  toUserIds?: string[]
}

type DeviceCommandInsert = Record<string, unknown> & {
  user_id: string
  device_id: string
  type: string
  payload: Record<string, unknown>
}

type DeviceCommandQueryResult = {
  data: unknown
  error: { message: string } | null
}

type DeviceCommandTableSelector = {
  eq(column: string, value: string): DeviceCommandTableSelector
  order(
    column: string,
    options: { ascending: boolean; nullsFirst?: boolean }
  ): {
    limit(count: number): PromiseLike<DeviceCommandQueryResult>
  }
  single(): PromiseLike<DeviceCommandQueryResult>
  maybeSingle(): PromiseLike<DeviceCommandQueryResult>
}

/** #5041 — identity.runtime_instances(#1676 的逐进程心跳表),持有判据据此判兄弟实例活/死。只读。 */
type RuntimeInstanceTableSelector = {
  eq(column: string, value: string): RuntimeInstanceTableSelector
  then<TResult1 = DeviceCommandQueryResult, TResult2 = never>(
    onfulfilled?: ((value: DeviceCommandQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>
}

type DeviceCommandTableUpdater = {
  eq(column: string, value: string): DeviceCommandTableUpdater
  select(columns: string): PromiseLike<DeviceCommandQueryResult>
  then<TResult1 = DeviceCommandQueryResult, TResult2 = never>(
    onfulfilled?: ((value: DeviceCommandQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>
}

export interface DeviceCommandTableClient {
  from(table: 'gugu_device_commands'): {
    insert(value: never): {
      select(columns: string): {
        single(): PromiseLike<DeviceCommandQueryResult>
      }
    }
    select(columns: string): DeviceCommandTableSelector
    update(patch: never): DeviceCommandTableUpdater
  }
  from(table: 'runtime_instances'): {
    select(columns: string): RuntimeInstanceTableSelector
  }
  // @@@1600 — 跨 agent 公平 fetch RPC（identity.fetch_fair_pending_device_commands）。
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DeviceCommandQueryResult>
}

export interface PollDeviceCommandOptions {
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface PendingDeviceCommand {
  id: string
  type: string
  payload: unknown
  created_at?: string
  claim_token?: string
}

export interface ProcessDeviceCommandResult {
  commandId: string
  type: string
  claimed: boolean
  status: 'done' | 'error' | 'skipped' | 'held' | 'deferred'
  /**
   * #5041 — `skipped` without a claim. `held-elsewhere`: a live sibling instance holds the target agent, the row is its.
   * `unheld`: no live instance holds it yet and the row is still inside the holder budget. `holding-unknown`: the
   * holding predicate threw; the row is left alone and the error is logged loud (never wedges the tick).
   */
  reason?: 'held-elsewhere' | 'unheld' | 'holding-unknown'
  result?: unknown
  error?: string
}

/**
 * #5041 — which runtime instance may execute a command. One device runs several instances at once (same
 * machine+account share one device_id; every process registers in runtime_instances) and each instance holds
 * only the agents in its own GUGU_HOME roster.
 *   `held`           this instance executes it (roster has the agent, or the command is not bound to a held agent).
 *   `held-elsewhere` a LIVE sibling instance holds the agent: leave the row to it, no timer at all.
 *   `unheld`         no live instance is known to hold the agent: leave it inside the holder budget (a holder may still
 *                    be booting), claim after so the handler lands a user-visible terminal.
 */
export type DeviceCommandHolding = 'held' | 'held-elsewhere' | 'unheld'

/** Mirror of recover_orphaned_device_commands' default p_stale_seconds: a runtime instance whose heartbeat is older is dead. */
export const RUNTIME_INSTANCE_STALE_MS = 90_000

/** The one accessor for the agent a command is bound to (ordering key, holding predicate and host log all read it here). */
export function deviceCommandAgentUserId(command: Pick<PendingDeviceCommand, 'payload'>): string {
  const payload = command.payload
  if (!payload || typeof payload !== 'object') return ''
  const id = (payload as { agent_user_id?: unknown }).agent_user_id
  return typeof id === 'string' ? id.trim() : ''
}

/** Age of a command row in ms, or null when created_at is absent/unparseable (callers state their own null policy). */
export function deviceCommandAgeMs(createdAt: string | undefined, nowIso: string): number | null {
  if (!createdAt) return null
  const created = Date.parse(createdAt)
  const now = Date.parse(nowIso)
  if (Number.isNaN(created) || Number.isNaN(now)) return null
  return now - created
}

const DEFERRED_DEVICE_COMMAND = Symbol('gugu.device-command.deferred')

export type DeferredDeviceCommandResult<T extends object> = T & {
  readonly [DEFERRED_DEVICE_COMMAND]: true
  readonly settlement: Promise<T>
}

/** Keep the claimed DB command running while its native turn settles out of band. */
export function deferDeviceCommand<T extends object>(
  result: T,
  settlement: Promise<T>,
): DeferredDeviceCommandResult<T> {
  return Object.defineProperties({ ...result }, {
    [DEFERRED_DEVICE_COMMAND]: { value: true },
    settlement: { value: settlement },
  }) as DeferredDeviceCommandResult<T>
}

function isDeferredDeviceCommandResult(value: unknown): value is DeferredDeviceCommandResult<object> {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Partial<DeferredDeviceCommandResult<object>>)[DEFERRED_DEVICE_COMMAND] === true,
  )
}

export type DeviceCommandHandlers = Record<
  string,
  (command: PendingDeviceCommand, signal?: AbortSignal) => Promise<unknown> | unknown
>

export interface ProcessDeviceCommandOptions {
  signal?: AbortSignal
  limit?: number
  nowIso?: () => string
  createClaimToken?: () => string
  // @@@1676 — 认领命令时写入的持有实例 id(claimed_by)。缺省=legacy(空),orphan 恢复按旧语义。
  instanceId?: string
  // #2115 — 命令落终态 error 时的可观测回调(held/成功不触发)。deliver 终态失败以前只落库、无人观察 →
  // 用户侧零提示;接线层(deviceRuntime)据此把 agent.deliver 失败转成 renderer 可见的 error 流事件。
  // 回调自身抛错不得影响 failDeviceCommand 落库(各自 try 隔离)。
  // #5041 — 第四个参数是原始 failure:handler 可以在错误对象上标记「已向用户显形」,宿主据此不再叠第二层通用提示。
  onCommandFailed?: (command: PendingDeviceCommand, error: string, cause?: string, failure?: unknown) => void
  operationTimeouts?: DeviceOperationTimeoutOverrides
  // #5041 — 持有判据:claim **之前**先问「这条命令的目标 agent 由谁持有」。held-elsewhere 不 claim、不改行、不计时;
  // unheld 在 AGENT_INIT_HELD_TIMEOUT_MS 的持有预算内不 claim,预算尽后 claim 让 handler 落用户可见的终态。
  // 缺省(老调用方/测试)= 全部视为持有,单实例语义不变。
  resolveHolding?: (command: PendingDeviceCommand) => Promise<DeviceCommandHolding> | DeviceCommandHolding
  // 落终态(done / error / held 回 pending)用的 client。一轮 agent.deliver 能跑得比这一拍拿到的令牌剩下的寿命还长,
  // 拿 tick 开始那个 client 去写 done ⇒ 令牌已过期、写不进去,命令永远停在 running。宿主据此在**写的那一刻**现取一个
  // 带当时有效令牌的 client。缺省 = 沿用 tick 的 client(老调用方/测试)。
  resolveSettleClient?: () => Promise<DeviceCommandTableClient>
  // 落终态的写抛错(网络 / 令牌 / 库)时的重试间隔;用尽仍失败才放弃(响亮记日志,服务端超时兜底收尾)。
  // CAS 没命中不是错误,是答案(别人已经落定或回收了),不重试。
  settleRetryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SETTLE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000]

export function createAgentDeliverDeviceCommandInsert(
  input: AgentDeliverDeviceCommandInput
): DeviceCommandInsert {
  return {
    user_id: input.userId,
    device_id: input.deviceId,
    type: AGENT_DELIVER_DEVICE_COMMAND,
    payload: {
      agent_user_id: input.agentUserId,
      chat_id: input.chatId,
      message_id: input.messageId,
      sender_user_id: input.senderUserId,
      content: input.content,
      ...(input.toUserIds?.length ? { to_user_ids: input.toUserIds } : {})
    }
  }
}

export async function insertAgentDeliverDeviceCommand(
  client: DeviceCommandTableClient,
  input: AgentDeliverDeviceCommandInput
): Promise<string> {
  const { data, error } = await client
    .from('gugu_device_commands')
    .insert(dbPayload(createAgentDeliverDeviceCommandInsert(input)))
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  const row = data && typeof data === 'object' ? (data as { id?: unknown }) : null
  if (typeof row?.id !== 'string' || row.id.length === 0) {
    throw new Error('Device command was not created')
  }
  return row.id
}

// @@@1875 — 用 .maybeSingle() 而非 .single()：轮询窗口内该命令行可能瞬时读到 0 行(插入后复制/可见性
// 抖动，或 owner-removal 类 RPC 的删除竞争)。.single() 对 0 行回 HTTP 406「Cannot coerce the result to a
// single JSON object」并抛错，会被 pollDeviceCommandUntilDone 当终态失败上抛 → 假阴「Agent 启动失败」。
// maybeSingle 把「0 行」表达成 null(非 error)，让轮询按「尚不可观测、继续等到 timeout」处理；真正的
// DB/网络 error 仍照常抛出、不吞。
export async function getDeviceCommand(
  client: DeviceCommandTableClient,
  commandId: string
): Promise<DeviceCommand | null> {
  const { data, error } = await client
    .from('gugu_device_commands')
    .select('id, status, result, error')
    .eq('id', commandId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data == null) return null
  return normalizeDeviceCommand(data)
}

// @@@1600 — 跨 agent 公平 fetch（治本 M4 held + 旧 device-wide LIMIT 5 饥饿)。
// 旧实现 `ORDER BY created_at ASC LIMIT 5` 跨所有 agent，held 命令(created_at 不变)永钉队首 → 一个 busy
// agent(pending≥5)霸占全部 fetch 槽 → 其余 agent 饥饿。改走 RPC fetch_fair_pending_device_commands:
// 每个 agent(及每条无 agent_user_id 的独立命令)每 tick 取其最旧 perAgent 条 → 结构性保证跨 agent 公平。
// partition key 与 deviceCommandOrderingKey 等价类一致;agent 内 FIFO 由 partition 内 created_at ASC 保;
// exactly-once 不变(本函数只读,认领仍由 claimDeviceCommand 原子完成)。
async function listPendingDeviceCommands(
  client: DeviceCommandTableClient,
  deviceId: string,
  perAgent: number,
  operationTimeouts: DeviceOperationTimeoutOverrides | undefined,
): Promise<PendingDeviceCommand[]> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'pending device command list',
    timeouts.pendingCommandListMs,
    () => client.rpc('fetch_fair_pending_device_commands', {
      p_device_id: deviceId,
      p_per_agent: perAgent,
    }),
  )
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Pending device command response must be an array')
  return data.map(normalizePendingDeviceCommand)
}

// @@@ orphan-recovery (#1676) — per-INSTANCE, not per-device.
// 一台 device 可并发多个 runtime 进程(deviceId 按 machine+user+tier 决定,相同)。旧实现把本 device 所有
// `running` 命令一律重置为 pending,假设「单 runtime,凡 running 必是我崩溃的孤儿」。多 runtime 下,新启
// 实例的 orphan 恢复会清掉活着兄弟在途的命令 → 其 ACP 会话被拆(SIGTERM)→ agent 不回消息。
// 改走 SECURITY DEFINER RPC:只回收「持有实例已死(心跳过期/缺失)或 legacy(claimed_by 为空)」的命令;
// 有新鲜心跳的活兄弟(含长 turn)安全保留。命令的 claimed_by 由 claimDeviceCommand 写入(见下)。
// 返回值 = 这一次放回 pending 的行数(RPC 的 ROW_COUNT)。放回是 UPDATE,而 `command_created` 广播只挂在
// INSERT 上 ⇒ 被放回的行**没有任何事件**会叫醒宿主;调用方据这个数决定要不要紧接着取一次命令。
export async function recoverOrphanedDeviceCommands(
  client: DeviceCommandTableClient,
  deviceId: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<number> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'orphaned device command recovery',
    timeouts.orphanRecoveryMs,
    () => client.rpc('recover_orphaned_device_commands', {
      p_device_id: deviceId,
    }),
  )
  if (error) throw new Error(error.message)
  if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) {
    throw new Error(`Orphaned device command recovery must return a row count, got ${JSON.stringify(data)}`)
  }
  return data
}

// @@@runtime-instance-heartbeat (#1676) — 注册/刷新本 runtime 进程的存活心跳(orphan 恢复据此判活/死)。
// 必须在 claim 之前调用,保证认领命令时本实例的心跳行已存在且新鲜,不会被兄弟的恢复误判为死实例。
export interface RuntimeInstanceHeartbeatReading {
  /**
   * @@@5912 库里那个设备租约清扫者上一次真的跑过是多久以前(秒)。
   *
   * 它搭这条 RPC 回来,而不是搭设备心跳:设备心跳是 PostgREST 的 upsert,没有可搭车的返回体;
   * 这条本来就是 RPC、宿主每 30 秒调一次 ⇒ 零额外请求。
   * `null` = 记账那一行不见了 —— 原样传出去当故障报,❌ 不在这里补一个好看的默认值。
   */
  readonly deviceLeaseSweepAgeSeconds: number | null
}

export async function reportRuntimeInstanceHeartbeat(
  client: DeviceCommandTableClient,
  instanceId: string,
  deviceId: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<RuntimeInstanceHeartbeatReading> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'runtime instance heartbeat',
    timeouts.runtimeInstanceHeartbeatMs,
    () => client.rpc('runtime_instance_heartbeat', {
      p_instance_id: instanceId,
      p_device_id: deviceId,
    }),
  )
  if (error) throw new Error(error.message)
  const row = data as Record<string, unknown> | null
  const age = row?.device_lease_sweep_age_seconds
  return {
    deviceLeaseSweepAgeSeconds: typeof age === 'number' && Number.isFinite(age) ? age : null,
  }
}

/** #5041 — this device's runtime instances (id + heartbeat). Owner-scoped RLS; one read per tick, lazily. */
export async function readDeviceRuntimeInstances(
  client: DeviceCommandTableClient,
  deviceId: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<Array<{ instanceId: string; lastHeartbeatAt: string }>> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'runtime instance list',
    timeouts.runtimeInstanceHeartbeatMs,
    () => client.from('runtime_instances').select('instance_id, last_heartbeat_at').eq('device_id', deviceId),
  )
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Runtime instance response must be an array')
  return data.map((row) => {
    const r = row as Record<string, unknown>
    if (typeof r.instance_id !== 'string' || typeof r.last_heartbeat_at !== 'string') {
      throw new Error('Runtime instance row is missing instance_id/last_heartbeat_at')
    }
    return { instanceId: r.instance_id, lastHeartbeatAt: r.last_heartbeat_at }
  })
}

/**
 * #5041 — who last executed a command bound to this agent on this device (`claimed_by` of the newest claimed row, running or
 * done). Holding is derived from execution history: the instance that last ran the agent's commands holds it, as long as its
 * heartbeat is fresh. No extra schema — claimed_by (#1676) already records exactly this fact. null = never claimed here.
 */
export async function latestClaimerForAgent(
  client: DeviceCommandTableClient,
  deviceId: string,
  agentUserId: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<string | null> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'latest claimer lookup',
    timeouts.commandLeaseMs,
    () => client
      .from('gugu_device_commands')
      .select('claimed_by')
      .eq('device_id', deviceId)
      .eq('payload->>agent_user_id', agentUserId)
      .order('claimed_at', { ascending: false, nullsFirst: false })
      .limit(1),
  )
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Latest claimer response must be an array')
  const claimedBy = (data[0] as Record<string, unknown> | undefined)?.claimed_by
  return typeof claimedBy === 'string' && claimedBy.length > 0 ? claimedBy : null
}

async function claimDeviceCommand(
  client: DeviceCommandTableClient,
  commandId: string,
  instanceId: string | undefined,
  nowIso = new Date().toISOString(),
  createClaimToken: () => string = () => globalThis.crypto.randomUUID(),
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<string | null> {
  // claimed_by 记录认领实例;缺 instanceId(老调用方/测试)留空 = legacy,orphan 恢复按旧语义回收。
  const claimToken = createClaimToken()
  const patch: Record<string, unknown> = {
    status: 'running',
    claimed_at: nowIso,
    claim_token: claimToken
  }
  if (instanceId) patch.claimed_by = instanceId
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'device command claim',
    timeouts.commandLeaseMs,
    () => client
      .from('gugu_device_commands')
      .update(dbPayload(patch))
      .eq('id', commandId)
      .eq('status', 'pending')
      .select('id, claim_token'),
  )
  if (error) throw new Error(error.message)
  if (!Array.isArray(data) || data.length === 0) return null
  const row = data[0] as Record<string, unknown>
  if (row.claim_token !== claimToken) throw new Error('Device command claim token mismatch')
  return claimToken
}

async function recheckDeviceCommandExecution(
  client: DeviceCommandTableClient,
  commandId: string,
  claimToken: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<boolean> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'device command lease recheck',
    timeouts.commandLeaseMs,
    () => client.rpc('recheck_device_command_execution', {
      p_id: commandId,
      p_claim_token: claimToken
    }),
  )
  if (error) throw new Error(error.message)
  return data === true
}

async function completeDeviceCommand(
  client: DeviceCommandTableClient,
  commandId: string,
  claimToken: string,
  result: unknown,
  nowIso = new Date().toISOString(),
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<boolean> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'device command completion',
    timeouts.commandSettlementMs,
    () => client
      .from('gugu_device_commands')
      .update(dbPayload({ status: 'done', result, completed_at: nowIso, error: null, claim_token: null }))
      .eq('id', commandId)
      .eq('claim_token', claimToken)
      .eq('status', 'running')
      .select('id'),
  )
  if (error) throw new Error(error.message)
  return Array.isArray(data) && data.length === 1
}

// @@@held-requeue - reset a held command back to 'pending' so the next tick re-fetches and retries it
// (mirrors recoverOrphanedDeviceCommands, but for a single command by id). Live producers of `held`:
// turn_in_flight + the agent-init held window (#1594). (Originated with the #638 inbox-gate, removed in #966.)
async function holdDeviceCommand(
  client: DeviceCommandTableClient,
  commandId: string,
  claimToken: string,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<boolean> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'device command hold',
    timeouts.commandSettlementMs,
    () => client
      .from('gugu_device_commands')
      .update(dbPayload({ status: 'pending', claimed_at: null, claimed_by: null, claim_token: null }))
      .eq('id', commandId)
      .eq('claim_token', claimToken)
      .eq('status', 'running')
      .select('id'),
  )
  if (error) throw new Error(error.message)
  return Array.isArray(data) && data.length === 1
}

async function failDeviceCommand(
  client: DeviceCommandTableClient,
  commandId: string,
  claimToken: string,
  errorMessage: string,
  nowIso = new Date().toISOString(),
  operationTimeouts?: DeviceOperationTimeoutOverrides,
  replyNotice?: 'in-chat' | 'context',
): Promise<boolean> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'device command failure',
    timeouts.commandSettlementMs,
    () => client
      .from('gugu_device_commands')
      .update(dbPayload({ status: 'error', error: errorMessage, completed_at: nowIso, claim_token: null, ...(replyNotice ? { result: { reply_notice: replyNotice } } : {}) }))
      .eq('id', commandId)
      .eq('claim_token', claimToken)
      .eq('status', 'running')
      .select('id'),
  )
  if (error) throw new Error(error.message)
  return Array.isArray(data) && data.length === 1
}

// @@@1466 命令排序键：带 agent_user_id 的命令按 agent 分组（同一 agent 内保序）；无 agent_user_id
// 的命令各自成组（独立、可并行）。同一 device 常托管多个 agent（dev 实测单设备 18 个），它们的
// agent.deliver 不应互相阻塞。
function deviceCommandOrderingKey(command: PendingDeviceCommand): string {
  const agentUserId = deviceCommandAgentUserId(command)
  return agentUserId ? `agent:${agentUserId}` : `cmd:${command.id}`
}

export async function processPendingDeviceCommandsOnce(
  client: DeviceCommandTableClient,
  deviceId: string,
  handlers: DeviceCommandHandlers,
  options: ProcessDeviceCommandOptions = {}
): Promise<ProcessDeviceCommandResult[]> {
  options.signal?.throwIfAborted()
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  // @@@1600 — options.limit 现为 per-agent 取条数(默认 1,契合 M4「一 agent 一次一 turn」);跨 agent 公平由
  // RPC 结构性保证,不再是旧的 device-wide 总量 5。
  const commands = await listPendingDeviceCommands(
    client,
    deviceId,
    options.limit ?? 1,
    options.operationTimeouts,
  )
  // @@@1466 多 agent 并行：原本一个 for-await 串行处理同 device 的全部命令 → 多个 agent 的 deliver
  // 顺序 await（agent B 等 agent A 整段 ACP/LLM 应答完）= owner 实测「顺序收、顺序回」。
  // 改：按 agent 分组，**不同 agent 间 Promise.all 并行、同一 agent 内仍串行保序**（消息顺序不乱）。
  // 安全：claimDeviceCommand 原子认领，跨组并发不会重复处理；processPendingDeviceCommand 内部
  // try/catch 吞错返错误结果，Promise.all 不因单条失败 reject。结果顺序：Map 保插入序 + Promise.all
  // 保数组序 → 一 agent 一命令的常见场景下与原顺序一致。
  const groups = new Map<string, PendingDeviceCommand[]>()
  for (const command of commands) {
    const key = deviceCommandOrderingKey(command)
    const existing = groups.get(key)
    if (existing) existing.push(command)
    else groups.set(key, [command])
  }
  const dispatch: DispatchContext = {
    nowIso,
    instanceId: options.instanceId,
    onCommandFailed: options.onCommandFailed,
    createClaimToken: options.createClaimToken,
    operationTimeouts: options.operationTimeouts,
    signal: options.signal,
    resolveHolding: options.resolveHolding,
    resolveSettleClient: options.resolveSettleClient,
    settleRetryDelaysMs: options.settleRetryDelaysMs ?? DEFAULT_SETTLE_RETRY_DELAYS_MS,
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  }
  const grouped = await Promise.all(
    Array.from(groups.values(), async (group) => {
      const out: ProcessDeviceCommandResult[] = []
      for (const command of group) {
        const result = await processPendingDeviceCommand(client, command, handlers, dispatch)
        out.push(result)
        if (!createMayBeQueuedBehind(command, result)) continue
        // #6264 同一个 agent 的建单与首条投递在同一个事务里写入(created_at 相同),公平取数按 id 定先后 ——
        // 投递可能排在建单前面。它因「还没有谁持有这个 agent」被按住时,建单根本取不到(每个 agent 一次只取一条),
        // 两条就一起等满持有预算,然后投递先落空(「这台设备上没有运行中的实例持有这个 agent」)。
        // 这里当场把那条建单找出来先办,再回头办这条投递。只在这种被按住的时候多查一次,❌ 每轮都查。
        const create = await findPendingAgentCreate(client, deviceId, deviceCommandAgentUserId(command), options.operationTimeouts)
        if (!create) continue
        out.push(await processPendingDeviceCommand(client, create, handlers, dispatch))
        out.push(await processPendingDeviceCommand(client, command, handlers, dispatch))
      }
      return out
    })
  )
  return grouped.flat()
}

/** 这一条是不是「agent 还没建出来」而被按住的非建单命令(它前面可能压着一条同 agent 的建单)。 */
function createMayBeQueuedBehind(command: PendingDeviceCommand, result: ProcessDeviceCommandResult): boolean {
  return command.type !== 'agent.create'
    && result.status === 'skipped'
    && result.reason === 'unheld'
    && deviceCommandAgentUserId(command) !== ''
}

async function findPendingAgentCreate(
  client: DeviceCommandTableClient,
  deviceId: string,
  agentUserId: string,
  operationTimeouts: DeviceOperationTimeoutOverrides | undefined,
): Promise<PendingDeviceCommand | null> {
  const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
  const { data, error } = await runDeviceRequest(
    'pending agent.create lookup',
    timeouts.pendingCommandListMs,
    () => client
      .from('gugu_device_commands')
      .select('*')
      .eq('device_id', deviceId)
      .eq('status', 'pending')
      .eq('type', 'agent.create')
      .eq('payload->>agent_user_id', agentUserId)
      .order('created_at', { ascending: true })
      .limit(1),
  )
  if (error) throw new Error(error.message)
  if (!Array.isArray(data) || data.length === 0) return null
  return normalizePendingDeviceCommand(data[0])
}

interface DispatchContext {
  nowIso: () => string
  instanceId?: string
  onCommandFailed?: ProcessDeviceCommandOptions['onCommandFailed']
  createClaimToken?: () => string
  operationTimeouts?: DeviceOperationTimeoutOverrides
  signal?: AbortSignal
  resolveHolding?: ProcessDeviceCommandOptions['resolveHolding']
  resolveSettleClient?: () => Promise<DeviceCommandTableClient>
  settleRetryDelaysMs: readonly number[]
  sleep: (ms: number) => Promise<void>
}

/** 落一次终态写:返回 CAS 是否命中。 */
type SettleWrite = (label: string, write: (client: DeviceCommandTableClient) => Promise<boolean>) => Promise<boolean>

/**
 * 落终态的写,每次尝试都现取 client(见 resolveSettleClient),抛错按退避重试;CAS 结果原样返回。
 * 重试用尽 ⇒ 抛最后一次的错 ❌ 吞:调用方决定怎么响亮。
 */
function terminalWriter(
  tickClient: DeviceCommandTableClient,
  commandId: string,
  { resolveSettleClient, settleRetryDelaysMs, sleep, signal }: DispatchContext,
): SettleWrite {
  return async (label, write) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = resolveSettleClient ? await resolveSettleClient() : tickClient
        return await write(client)
      } catch (error) {
        // 令牌永久失效 / 换了 owner:重试不会好,原样抛给宿主的「请重新登录」守卫(@@@4395),❌ 吞成普通失败。
        if (error instanceof RuntimeAuthExpiredError) throw error
        const delayMs = settleRetryDelaysMs[attempt]
        // 宿主停了就不再等:停机会等这一拍收尾,几分钟的退避会把退出拖住;行留给服务端超时兜底。
        if (delayMs === undefined || signal?.aborted) throw error
        log.warn(
          { commandId, label, attempt: attempt + 1, delayMs, err: error instanceof Error ? error.message : String(error) },
          'device command terminal write failed; retrying with a fresh client',
        )
        await abortableSleep(sleep, delayMs, signal)
        if (signal?.aborted) throw error
      }
    }
  }
}

function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms)
  return new Promise<void>((resolve) => {
    const done = () => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
    void sleep(ms).then(done, done)
  })
}

// #5041 — 无人持有的命令的持有预算(= AGENT_INIT_HELD_TIMEOUT_MS,与 held 窗口同一个「等本机基础设施」预算):持有者可能正在冷启动、
// 尚未登记心跳,预算内把行留着;预算尽仍无人认领才由任一实例 claim。行缺 created_at(或不可解析)无从计预算 ⇒ 视同预算已尽:
// claim 后 handler fail loud 落终态。❌ 让一条畸形行把整台设备的 tick 卡死,也 ❌ 让它无界 pending。
function unheldBudgetExhausted(command: PendingDeviceCommand, nowIso: string): boolean {
  const age = deviceCommandAgeMs(command.created_at, nowIso)
  return age === null || age >= AGENT_INIT_HELD_TIMEOUT_MS
}

/**
 * #5041 — 持有门,在 claim 之前。判据抛错只影响这一行(skipped + holding-unknown,console.error 响亮),❌ 让一次名册读失败把
 * 整台设备的 tick 拒掉、所有命令永远 pending;行本身仍由持有预算兜底落终态。
 */
async function holdingGate(
  command: PendingDeviceCommand,
  resolveHolding: NonNullable<ProcessDeviceCommandOptions['resolveHolding']>,
  nowIso: string,
): Promise<ProcessDeviceCommandResult | null> {
  const skipped = (reason: NonNullable<ProcessDeviceCommandResult['reason']>): ProcessDeviceCommandResult =>
    ({ commandId: command.id, type: command.type, claimed: false, status: 'skipped', reason })
  let holding: DeviceCommandHolding
  try {
    holding = await resolveHolding(command)
  } catch (error) {
    log.error(
      { commandId: command.id, type: command.type, err: error instanceof Error ? error.message : String(error) },
      'holding predicate failed; leaving the row for its holder',
    )
    return skipped('holding-unknown')
  }
  if (holding === 'held-elsewhere') return skipped('held-elsewhere')
  if (holding === 'unheld' && !unheldBudgetExhausted(command, nowIso)) return skipped('unheld')
  return null
}

async function processPendingDeviceCommand(
  client: DeviceCommandTableClient,
  command: PendingDeviceCommand,
  handlers: DeviceCommandHandlers,
  dispatch: DispatchContext,
): Promise<ProcessDeviceCommandResult> {
  const { nowIso, instanceId, onCommandFailed, createClaimToken, operationTimeouts, signal, resolveHolding } = dispatch
  signal?.throwIfAborted()
  if (resolveHolding) {
    const gated = await holdingGate(command, resolveHolding, nowIso())
    if (gated) return gated
  }
  const claimToken = await claimDeviceCommand(
    client,
    command.id,
    instanceId,
    nowIso(),
    createClaimToken,
    operationTimeouts,
  )
  if (!claimToken) {
    return { commandId: command.id, type: command.type, claimed: false, status: 'skipped' }
  }
  // 认领之后的一切终态写都走它:handler 可能跑了很久,tick 的 client 带的令牌未必还有效。
  const settle = terminalWriter(client, command.id, dispatch)
  const settleOnce = terminalWriter(client, command.id, { ...dispatch, settleRetryDelaysMs: [] })
  // 重试已用尽:这一行留在 running,由服务端的 running 超时兜底落成 error。
  const lostSettlement = (error: unknown) => {
    log.error(
      { commandId: command.id, type: command.type, err: error instanceof Error ? error.message : String(error) },
      'device command settlement could not be written; the row stays running until the server-side timeout settles it',
    )
  }
  // 同步 handler 的终态写在这一拍里只试一次;写不进去就把重试挪出这一拍(报 deferred),
  // ❌ 在拍里退避几分钟 —— 那会把同设备随后到的命令(别的 agent 的投递、stop)全堵住。
  const offTick = async (
    run: (write: SettleWrite) => Promise<ProcessDeviceCommandResult>,
  ): Promise<ProcessDeviceCommandResult> => {
    try {
      return await run(settleOnce)
    } catch (error) {
      if (error instanceof RuntimeAuthExpiredError) throw error
      log.warn(
        { commandId: command.id, type: command.type, err: error instanceof Error ? error.message : String(error) },
        'device command terminal write failed in the tick; retrying off the tick',
      )
      void run(settle).catch(lostSettlement)
      return { commandId: command.id, type: command.type, claimed: true, status: 'deferred' }
    }
  }
  const skipped: ProcessDeviceCommandResult = { commandId: command.id, type: command.type, claimed: true, status: 'skipped' }

  let result: unknown
  try {
    signal?.throwIfAborted()
    if (!(await recheckDeviceCommandExecution(client, command.id, claimToken, operationTimeouts))) return skipped
    const handler = handlers[command.type]
    if (!handler) throw new Error(`unsupported command type: ${command.type}`)
    const claimedCommand = { ...command, claim_token: claimToken }
    result = await handler(claimedCommand, signal)
  } catch (err) {
    return offTick((write) =>
      failClaimedDeviceCommand(write, command, claimToken, err, nowIso, onCommandFailed, operationTimeouts))
  }
  if (isDeferredDeviceCommandResult(result)) {
    void settleDeferredDeviceCommand(settle, command, claimToken, result.settlement, nowIso, onCommandFailed, operationTimeouts)
      .catch(lostSettlement)
    return { commandId: command.id, type: command.type, claimed: true, status: 'deferred' }
  }
  // @@@held-requeue - a held result signals "don't complete; requeue for retry" (turn_in_flight /
  // agent-init not-ready, #1594). Reset to 'pending' (mirrors recoverOrphanedDeviceCommands) so the next
  // tick re-fetches it.
  if (result && typeof result === 'object' && 'held' in result && result.held) {
    return offTick(async (write) =>
      (await write('hold', (c) => holdDeviceCommand(c, command.id, claimToken, operationTimeouts)))
        ? { commandId: command.id, type: command.type, claimed: true, status: 'held', result }
        : skipped)
  }
  return offTick(async (write) =>
    (await write('complete', (c) => completeDeviceCommand(c, command.id, claimToken, result, nowIso(), operationTimeouts)))
      ? { commandId: command.id, type: command.type, claimed: true, status: 'done', result }
      : skipped)
}

async function settleDeferredDeviceCommand(
  settle: SettleWrite,
  command: PendingDeviceCommand,
  claimToken: string,
  settlement: Promise<object>,
  nowIso: () => string,
  onCommandFailed?: ProcessDeviceCommandOptions['onCommandFailed'],
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<void> {
  // 回合的结局与「把结局写进库」是两件事:写失败 ❌ 冒充回合失败(那会把一轮成功的回合改写成 error)。
  let outcome: { ok: true; result: object } | { ok: false; failure: unknown }
  try {
    outcome = { ok: true, result: await settlement }
  } catch (failure) {
    outcome = { ok: false, failure }
  }
  if (!outcome.ok) {
    await failClaimedDeviceCommand(settle, command, claimToken, outcome.failure, nowIso, onCommandFailed, operationTimeouts)
    return
  }
  const { result } = outcome
  await settle('complete', (c) => completeDeviceCommand(c, command.id, claimToken, result, nowIso(), operationTimeouts))
}

async function failClaimedDeviceCommand(
  settle: SettleWrite,
  command: PendingDeviceCommand,
  claimToken: string,
  failure: unknown,
  nowIso: () => string,
  onCommandFailed?: ProcessDeviceCommandOptions['onCommandFailed'],
  operationTimeouts?: DeviceOperationTimeoutOverrides,
): Promise<ProcessDeviceCommandResult> {
  const error = failure instanceof Error ? failure.message : String(failure)
  // Keep the user-facing command error sanitized while preserving the original
  // cause for the host's diagnostic log. Turn failures intentionally throw the
  // generic disclosure after posting the in-chat notice.
  const sourceCause = failure instanceof Error ? (failure as Error & { cause?: unknown }).cause : undefined
  const cause = sourceCause instanceof Error
    ? sourceCause.message
    : undefined
  // #2115/#2159 — land the terminal CAS before notifying observers, including deferred turns.
  const disclosedInChat = Boolean(failure && typeof failure === 'object' && 'disclosedInChat' in failure && failure.disclosedInChat === true)
  const replyNotice = command.type === 'agent.deliver' ? disclosedInChat ? 'in-chat' : 'context' : undefined
  if (!(await settle('fail', (c) => failDeviceCommand(c, command.id, claimToken, error, nowIso(), operationTimeouts, replyNotice)))) {
    return { commandId: command.id, type: command.type, claimed: true, status: 'skipped' }
  }
  try {
    onCommandFailed?.(command, error, cause, failure)
  } catch (callbackError) {
    console.warn(`[device-commands] onCommandFailed callback threw for ${command.id}:`, callbackError)
  }
  return { commandId: command.id, type: command.type, claimed: true, status: 'error', error }
}

export function normalizeDeviceCommand(value: unknown): DeviceCommand {
  if (!value || typeof value !== 'object') throw new Error('Device command row is missing')
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const status = row.status
  if (!id) throw new Error('Device command row is missing id')
  if (status !== 'pending' && status !== 'running' && status !== 'done' && status !== 'error') {
    throw new Error(`Invalid device command status: ${String(status)}`)
  }
  return {
    id,
    status,
    result: row.result ?? null,
    error: row.error === null || row.error === undefined ? null : String(row.error)
  }
}

function normalizePendingDeviceCommand(value: unknown): PendingDeviceCommand {
  if (!value || typeof value !== 'object') throw new Error('Pending device command row is missing')
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const type = typeof row.type === 'string' ? row.type : ''
  if (!id) throw new Error('Pending device command row is missing id')
  if (!type) throw new Error('Pending device command row is missing type')
  // @@@command-created-at (#945, 回港 aa10439) - 透传 created_at 给 agent-init held 窗口消费者(#1594)。
  return {
    id,
    type,
    payload: row.payload ?? null,
    created_at: typeof row.created_at === 'string' ? row.created_at : undefined
  }
}

export async function pollDeviceCommandUntilDone(
  getCommand: () => Promise<DeviceCommand | null>,
  options: PollDeviceCommandOptions = {}
): Promise<DeviceCommand> {
  // @@@1594 警示:默认 90_000 远小于 runtime 的 create held 重试窗口(AGENT_INIT_HELD_TIMEOUT_MS,现 150s)——
  // 若命令在 runtime 合法重试到 90s 后才落终态,默认会在终态前超时(timed out,而非真失败)。会 requeue 重试的
  // 命令(agent.create 类)不要依赖裸默认值。
  // 会 requeue 重试的命令若走这条裸 poll 且**不**做超时后状态复核,需显式传 ≥ held+余量 的 timeoutMs。
  const timeoutMs = options.timeoutMs ?? 90_000
  const intervalMs = options.intervalMs ?? 700
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const command = await getCommand()
    // @@@1875 — null = 该命令行此刻读到 0 行(插入后尚不可见 / 删除竞争)，是瞬时态、非终态失败：在 timeout
    // 窗口内继续轮询等它变可见。仅真正的 error status 或 timeout 才 loud reject(见 getDeviceCommand 注释)。
    if (command) {
      if (isDeviceCommandDone(command)) return command
      if (isDeviceCommandError(command)) {
        throw new Error(command.error || 'Device command failed')
      }
    }
    await sleep(intervalMs)
  }
  throw new Error('Device command timed out')
}
