import {
  createAgentRuntimeStateReporter,
  DeviceCapabilityTimeoutError,
  DEVICE_COMMAND_DRAIN_RETRY_INTERVAL_MS,
  DEVICE_SUPERVISE_INTERVAL_MS,
  DEVICE_HEARTBEAT_INTERVAL_MS,
  resolveLocalDeviceId,
  runDeviceRuntimeTick,
  syncDeviceHeartbeat,
  cleanupLegacyDeviceRows,
  type AgentDeliverFailure,
  type AgentRuntimeStateRpcClient,
  type DeviceCapabilitiesSource,
  type DeviceSessionDigestSource,
  type DeviceActionsSource,
  type DeviceIdCacheWriter,
  type DeviceHeartbeatOptions,
  type DeviceMachineIdentifier,
  type DeviceRuntimeTickResult as CoreDeviceRuntimeTickResult,
  type DeviceHeartbeatTableClient
} from './deviceRuntime'
import {
  reportRuntimeInstanceHeartbeat,
  type DeviceCommandTableClient,
  type ProcessDeviceCommandResult,
  RUNTIME_INSTANCE_STALE_MS,
  type RuntimeInstanceHeartbeatReading,
} from './deviceCommands'
import {
  RuntimeAuthExpiredError,
  type RuntimeAuth,
  type RuntimeAuthProvider
} from './runtimeAuthProvider'
import { listAgents, removeAgents, type LocalAgentRecord } from '../local/state/agents'
import { CLOUD_AGENT_TYPE } from '../agentTypes'
import {
  clearLocalAgentRuntimesForOwnerChange,
  pruneStaleGuestRecords,
  syncAgentRuntimeSessions,
  type AgentRosterRemovalReason,
  type AgentRuntimeBridge,
} from '../local/agent/deviceCommandRuntime'
import { agentsForOwner } from '../local/state/agentOwner'
import { agentCloudIdentityPending } from '../local/state/agentCloudIdentity'
// @@@5912 清扫者停摆的判据取一个完整的租约 TTL —— 与库里那条 `interval '2 minutes'` 同源。
import { DEVICE_ONLINE_STALE_MS } from '../shared/enums/deviceModels'
import {
  publishAgentStatusTransitions,
  publishedStatusOf,
  samePublishedStatus,
  sweepLocalAgentsOnline,
  type PublishedAgentStatus,
} from './deviceRuntimeSweep'
import type { AgentStatusReading } from '../shared/agentStatus'
import type { AgentRuntimeStateWrite } from './agentRuntimeStateReporter'
import { isDeviceRemovedError } from './devices'
import { MACHINE_LIMIT_NEXT_STEP, machineLimitMessage, machineLimitRefusalFromError } from './machineLimit'
import {
  DeviceOperationTimeoutError,
  type DeviceOperationTimeoutOverrides,
} from './deviceOperationTimeouts'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, stateDir } from '../local/state/paths'

export type DeviceRuntimeIdentityClient = DeviceCommandTableClient &
  DeviceHeartbeatTableClient &
  AgentRuntimeStateRpcClient

/**
 * 一轮 tick 被什么叫起来的。两种做的事相同,区别只在**归因**:`event` 有事件说「该取命令了」;`reconcile`
 * 是对账节拍 —— 队列本该是空的,取到了行就说明有一条没被任何事件通知过。合同见 spec device-runtime。
 */
export type DeviceRuntimeTickTrigger = 'event' | 'reconcile'

export type SubscribeDeviceCommandWake = (input: {
  deviceId: string
  accessToken: string
  /** 有行变成 pending 了。事件点名了哪一行就带上它的 id(广播负载里有);不带 = 泛指(订上时的补拉)。 */
  onCommand: (commandId?: string) => Promise<void>
  /**
   * 频道真的订上了(含每一次重订)。`subscribe()` 返回 ≠ 订上了,真实结果之后才异步到。实现方还应在这一刻补拉一轮。
   */
  onSubscribed?: () => void
  /**
   * 订上过的频道掉了(实现方在退避重连)。不报这一声,宿主会把掉线期间入队的行记成「广播丢了」。
   */
  onSubscriptionLost?: () => void
  onSubscribeFailure: () => void
}) => Promise<() => void> | (() => void)

// @@@device-rpc-seam - same inject shape as SubscribeDeviceCommandWake: the host owns realtime
export type SubscribeDeviceRpc = (input: {
  deviceId: string
  accessToken: string
}) => Promise<() => void> | (() => void)

export interface DeviceRuntimeHostOptions {
  env?: NodeJS.ProcessEnv
  /** 排空跟进的间隔(上一轮取到过命令却没有一条落终态时,隔多久复查)。❌ 不是轮询周期,见 spec device-runtime。 */
  intervalMs?: number
  /** 对账节拍(孤儿恢复闸 / activity 对账闸 / 订阅自检,并取一次命令)。 */
  superviseIntervalMs?: number
  heartbeatIntervalMs?: number
  capabilityTimeoutMs?: number
  // @@@1676 — 周期性 orphan 恢复间隔(ms);缺省 ORPHAN_RECOVERY_INTERVAL_MS。
  orphanRecoveryIntervalMs?: number
  /** activity 周期对账间隔(@@@activity-reconcile);缺省 ACTIVITY_RECONCILE_INTERVAL_MS。 */
  activityReconcileIntervalMs?: number
  /** @@@5912 legacy / 陈旧设备行清理的周期;缺省 LEGACY_DEVICE_CLEANUP_INTERVAL_MS。 */
  legacyCleanupIntervalMs?: number
  nowMs?: () => number
  authProvider: RuntimeAuthProvider
  makeIdentityClient: (accessToken: string) => DeviceRuntimeIdentityClient
  nowIso?: () => string
  capabilities?: DeviceCapabilitiesSource
  /** 会话状态摘要（离线时手机读它）。缺省 = 这台机器不报摘要。 */
  sessionDigest?: DeviceSessionDigestSource
  /** #7199 这台设备能被调用的动作清单(随心跳登记)。缺省 = 不登记。 */
  deviceActions?: DeviceActionsSource
  /** 设备在「在哪跑」里的默认名；缺省 = hostname 第一段。用户改过名后心跳不会覆写（见 rename_device）。 */
  label?: () => string
  operationTimeouts?: DeviceOperationTimeoutOverrides
  /** P4: ACP 运行时桥（electron 注入）；agent.cache.acp_engine_id 有值时走 ACP。 */
  runtimeBridge?: AgentRuntimeBridge
  /**
   * A local roster row was removed: at an owner switch (`owner-change`), or because the cloud no longer has
   * the agent (`cloud-gone`, the gone guard below — #6938: the host revokes the cards it issued to it).
   */
  onAgentRosterRemoved?: (agent: LocalAgentRecord, reason: AgentRosterRemovalReason) => Promise<void> | void
  /**
   * #4277 owner 边界确立/变更时通知宿主(首次鉴权 tick 也算一次)。宿主拿它切按账号分的日志文件等
   * 「跟着当下登录走」的东西。回调抛错只 warn,❌ 不拖垮 tick。
   */
  onOwnerEstablished?: (ownerUserId: string, previousOwnerUserId: string | null) => Promise<void> | void
  // @@@scheduled-tasks (#987) - 评估 owner 的到期定时任务并经 ACP deliver 触发（electron 注入实现，
  // 内部用全量 client 建 gateway 调 runDueScheduledTasks）。best-effort，异常不影响设备命令。
  // 返回**最早的未来到期时刻**:宿主据此挂一次性定时器、到点才再扫,❌ 不搭任何 tick 的车。
  runScheduledTasks?: (ctx: { ownerUserId: string; accessToken: string; nowMs: number; /** 这台宿主自己的设备 id(还没注册上 = null)。 */ deviceId: string | null }) => Promise<{ nextDueAtMs: number | null }>
  /**
   * 新命令的事件源。`start()` 要求它在场:宿主不轮询命令,没有事件源的宿主收不到任何新命令。
   */
  subscribeCommandWake?: SubscribeDeviceCommandWake
  subscribeDeviceRpc?: SubscribeDeviceRpc
  warn?: (message: string) => void
  // @@@auth-expired-signal - fired exactly once when the host's auth is PERMANENTLY lost (refresh
  onAuthExpired?: (message: string) => void
  /**
   * #6264 账号主人在「设置 → 设备」里移除了这台机器(库对这台的心跳回 DEVICE_REMOVED)。
   * 只触发一次。咕咕 server 据此退出这个账号的登录;桌面不传(桌面行不会被这样拦)。
   */
  onDeviceRemoved?: (message: string) => void
  machineIdentifier?: DeviceMachineIdentifier
  deviceIdCacheWriter?: DeviceIdCacheWriter
  // #2115 — agent.deliver 终态失败上抛(→ electron main 发 error 流事件,renderer 显失败提示+重试)。
  onAgentDeliverFailure?: (failure: AgentDeliverFailure) => void
}

export interface DeviceRuntimeHostTickResult {
  skipped: boolean
  deviceId?: string
  commands?: CoreDeviceRuntimeTickResult['commands']
}

export interface DeviceRuntimeHostDebugSnapshot {
  status: 'idle' | 'running' | 'ticking' | 'stopped'
  started: boolean
  ticking: boolean
  hasAuth: boolean
  // @@@auth-expired-flag - distinct from `hasAuth: false` (which also covers "not logged in yet").
  authExpired: boolean
  commandWakeSubscribed: boolean
  queuedCommandWake: boolean
  /** 排空跟进是否已挂上(= 上一轮取到过命令,队列还没静默)。 */
  drainFollowUpArmed: boolean
  lastDeviceId: string | null
  lastTickAt: number | null
  lastError: string | null
}

export interface DeviceRuntimeHost {
  tickOnce: () => Promise<DeviceRuntimeHostTickResult>
  /**
   * 登录态变了(登录 / 换号 / 登出)⇒ 立刻跑一轮,❌ 别让对账节拍去「发现」一个本来就有事件的事实。
   * ⚠️ 调用方要先让 auth provider 忘掉缓存的旧令牌,否则这一轮问到的还是上一个人。
   */
  notifyAuthChanged: () => void
  /**
   * 本机把一条命令放回了 pending(失败条的「重试」)。那是 UPDATE,而广播只挂在 INSERT 上 ⇒ 库那侧没有事件,由发起方说这一声。
   */
  notifyCommandsChanged: () => void
  /**
   * 这台机器能被调用的动作变了(一组授权开 / 关、电脑控制的 App 开 / 关,#7317)⇒ 当场写一次心跳,别的机器上的 agent 立刻读到新清单。
   * ❌ 为这件事调 `tickOnce()` —— tick 只在心跳到期(30 s 一拍)时才写,清单最多旧 30 s。还没 start 就什么都不做:首轮按那时的清单登记。
   */
  notifyDeviceActionsChanged: () => void
  start: () => void
  stop: () => Promise<void>
  getDebugSnapshot: () => DeviceRuntimeHostDebugSnapshot
}

export interface RuntimeStopHost {
  stop: () => Promise<void> | void
}

export async function stopRuntimeHostWithTimeout(
  host: RuntimeStopHost,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      Promise.resolve(host.stop()),
      new Promise<never>((_, reject) => {
        // @@@runtime-stop-timeout - This bounds shutdown waiting; it cannot cancel already-started cleanup.
        timeout = setTimeout(() => reject(new Error(`runtime stop timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// @@@1676 — 周期性 orphan 恢复的默认间隔(可注入覆盖,便于测试)。见下方使用处说明。
export const ORPHAN_RECOVERY_INTERVAL_MS = 60_000
// @@@activity-reconcile — activity 周期对账间隔:响应性(卡死 running 最多存活约一个周期)与写放大
// (N 个本机 agent × 幂等 upsert)的折中。
export const ACTIVITY_RECONCILE_INTERVAL_MS = 120_000
// @@@5912 legacy / 陈旧设备行清理的周期。它此前挂在每一拍心跳上(空闲时每 30 秒一个请求),
// 而它清的是历史垃圾:一行多留半小时没有任何人会注意到。但也**不能只跑一次** —— 判据带时间,
// 同一个 owner 下答案会改口(见使用处)。
export const LEGACY_DEVICE_CLEANUP_INTERVAL_MS = 30 * 60_000

function deviceRuntimeOwnerFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'device-runtime-owner.json')
}

async function readDeviceRuntimeOwner(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = deviceRuntimeOwnerFile(env)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid device runtime owner state at ${path}`)
  }
  const ownerUserId = (parsed as { owner_user_id?: unknown } | null)?.owner_user_id
  if (typeof ownerUserId !== 'string' || !ownerUserId) {
    throw new Error(`Invalid device runtime owner state at ${path}`)
  }
  return ownerUserId
}

async function writeDeviceRuntimeOwner(ownerUserId: string, env: NodeJS.ProcessEnv): Promise<void> {
  await atomicWriteText(
    deviceRuntimeOwnerFile(env),
    `${JSON.stringify({ owner_user_id: ownerUserId }, null, 2)}\n`,
  )
}

export function createDeviceRuntimeHostLoop(
  options: DeviceRuntimeHostOptions
): DeviceRuntimeHost {
  const env = options.env ?? process.env
  const intervalMs = options.intervalMs ?? DEVICE_COMMAND_DRAIN_RETRY_INTERVAL_MS
  const superviseIntervalMs = options.superviseIntervalMs ?? DEVICE_SUPERVISE_INTERVAL_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEVICE_HEARTBEAT_INTERVAL_MS
  // @@@1676 — orphan 恢复改为**周期性**(非仅启动一次)。多并发 runtime 下,某实例运行中崩溃后其在途命令
  // (claimed_by=死实例)需被回收重派;若只在实例启动时恢复,得等下一个实例启动才清理 → 并发测试里崩溃常态
  // 下孤儿长期卡 running。恢复已按实例归属(只回收心跳过期/缺失或 legacy 的孤儿),对活兄弟零误伤,故周期化纯增益。
  // 周期 ≈ stale 窗口量级:死实例心跳过期(默认 90s)后,下一轮恢复(~60s 一次)即重派 → 端到端 ~90-150s 自愈。
  const orphanRecoveryIntervalMs = options.orphanRecoveryIntervalMs ?? ORPHAN_RECOVERY_INTERVAL_MS
  // @@@activity-reconcile — agent_runtime_states 的 activity 周期对账。settle 时的 idle 上报是单次
  // best-effort 写:丢一次(网络抖动/auth 瞬断)且 host 不重启,行就永远卡 running(实测:成员回合正常结束、
  // 会话正常闲置驱逐,UI 却整夜「运行中」;#1947 的 UI 自愈信权威行,权威行错了反而治不到)。对账 = 复用
  // @@@1528 的 online/idle sweep,但跳过真有 turn 在飞的 agent(runtimeBridge.agentStatus 的读数是权威真值),
  // 周期化后单次写丢失的伤害从「永久」降到「一个对账周期」。
  const activityReconcileIntervalMs = options.activityReconcileIntervalMs ?? ACTIVITY_RECONCILE_INTERVAL_MS
  const legacyCleanupIntervalMs = options.legacyCleanupIntervalMs ?? LEGACY_DEVICE_CLEANUP_INTERVAL_MS
  const nowMs = options.nowMs ?? (() => Date.now())
  // @@@gate-slack — 孤儿恢复(60 s)与 activity 对账(120 s)两个闸恰是对账节拍的整数倍,「距上次 59 998 ms」这种抖动
  // 会让闸整整滑到下一拍。⇒ 留十分之一拍的余量(生产 3 s)。2 秒一轮时这点量化误差可以忽略,现在不行。
  const gateOpen = (lastAt: number | null, intervalMs: number, at: number): boolean =>
    lastAt === null || at - lastAt >= intervalMs - Math.min(intervalMs, superviseIntervalMs) / 10
  // @@@1676 — 本 runtime 进程的实例 id,host loop 生命周期内固定一次。一台 device 可并发多进程(deviceId
  // 相同),靠它把命令认领归属到具体进程,orphan 恢复只回收死实例(心跳过期)的孤儿,不误清活兄弟在途命令。
  const instanceId = `${hostname().split('.')[0]}:${randomUUID()}`
  // @@@event-driven-work (#5906) — 宿主里没有公共节拍器,每件事由它自己的事实驱动(合同见 spec device-runtime):
  //  · 事件 / drainFollowUp  新命令靠 wake 事件进来;取到过行就再跑一轮,直到取空。
  //  · superviseTimer        对账节拍:事件之外唯一周期性的一轮 tick,取到没被事件通知过的行就响亮告警。
  //  · heartbeatTimer        设备心跳与实例租约,自己的节律。 · scheduledTasks  按最早到期时刻挂的一次性定时器。
  let superviseTimer: ReturnType<typeof setInterval> | null = null
  let drainFollowUpTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledTasksTimer: ReturnType<typeof setTimeout> | null = null
  let activeScheduledTasksRun: Promise<void> | null = null
  let scheduledTasksPlanned = false
  let workFailureStreak = 0
  let drainFollowUpDueAt = 0
  // wake 此刻是不是真的订着(由订阅实现的 onSubscribed / onSubscribeFailure 写,❌ 不由「subscribe() 调用返回了」推断)。
  let wakeSubscribed = false
  let wakeSubscribeFailures = 0
  // 上一轮取命令取到的是不是空集。对账 tick 据此判「这一轮取到的行有没有被事件通知过」:
  // 上一轮非空 ⇒ 排空跟进本来就在复查它们,取到是预期;上一轮为空 ⇒ 这些行是悄悄出现的。
  let queueBelievedEmpty = false
  // 「这些行没被事件通知过」的判定(见 reportUnannouncedCommands):这一轮期间被点名的行 / 泛指的通知,
  // 以及等着落槌的那批行 id。
  const announcedDuringTick = new Set<string>()
  let blanketAnnouncementDuringTick = false
  let unannouncedVerdict: { pending: Map<string, string>; timer: ReturnType<typeof setTimeout> } | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let activeHeartbeat: Promise<void> | null = null
  let activeLeaseRenewal: Promise<void> | null = null
  // Suppress immediate retry storms after a capability timeout; the next explicit work tick
  // clears this latch and starts a fresh probe.
  let heartbeatCapabilityTimedOut = false
  // #4008 —— activity 的发布有自己的节律与单飞,**不挂在 work tick 上**:work tick 会被它要描述的那件事
  // 本身占满(一条 ACP 的 agent.deliver 是被 tick await 的,而它底下等的是整轮 sendPrompt)⇒ 挂在 tick 上
  // 的发布器在整个回合里一次也轮不到,权威于是整轮停在 idle,群聊(纯 presence 驱动)全程显示空闲。
  let activityTimer: ReturnType<typeof setInterval> | null = null
  let activeActivityPublish: Promise<void> | null = null
  let activityPublishQueued = false
  let unsubscribeAgentTurnState: (() => void) | null = null
  let ticking = false
  let activeTick: Promise<DeviceRuntimeHostTickResult> | null = null
  let activeTickAbortController: AbortController | null = null
  const heartbeatFlights = new Map<string, Promise<void>>()
  let lastHeartbeatAt: number | null = null
  // @@@5912 上一次实例租约续成功的时刻(**不分是哪条腿续的**)。tick 据此跳过自己那一次续租。
  let lastLeaseRenewAt: number | null = null
  // @@@5912 上一次跑 legacy / 陈旧行清理的时刻。换 owner 要重来 —— 那是另一批行。
  let lastLegacyCleanupAt: number | null = null
  let commandWake: { deviceId: string; accessToken: string; unsubscribe: () => void } | null = null
  let commandWakeEpoch = 0
  let deviceRpc: { deviceId: string; accessToken: string; unsubscribe: () => void } | null = null
  let lifecycleGeneration = 0
  let lastAuth: RuntimeAuth | null = null
  let activeOwnerUserId: string | null = null
  let persistedOwnerUserId: string | null | undefined
  let lastDeviceId: string | null = null
  let lastTickAt: number | null = null
  let lastError: string | null = null
  let authExpired = false
  let lastOrphanRecoveryAt: number | null = null
  let lastActivityReconcileAt: number | null = null
  // @@@1528 - mark local agents online once per host lifecycle when the device runtime first
  // becomes ready. Fixes 假离线.
  let localAgentsOnlineSwept = false
  // 本机 agent 的令牌档最近一次整批写成时用的 access token,与没写成时下一次重试的时刻(见 maintainLocalAgents)。
  let runtimeSessionsAccessToken: string | null = null
  let runtimeSessionsRetryAt = 0
  // @@@activity-edge (#3961) — 「已发布过什么」的记忆,让 2 秒一轮的节律只在读数**变化**时才写。
  // presence 行的每一次写(对账、边沿、建 / 停的收敛写、下线)都经 reportPresence 记进这里,
  // 所以谁都不会把另一个写回旧值,也不会对一个已经写过的值再写一遍。
  const publishedActivity = new Map<string, PublishedAgentStatus>()
  const publishedRecentActions = new Map<string, string>()
  let stopped = false
  let queuedCommandWake: {
    promise: Promise<void>
    resolve: () => void
    reject: (reason: unknown) => void
  } | null = null

  // @@@2151 gone-agent 守卫收口:所有 runtime-state 写点都经此 guarded reporter。RPC 命中「not writable」
  // (agent 别处删/非本 owner)时 → 本地 drop + swallow(❌ 不 throw、不 stderr),一处覆盖全部写点
  // (startup sweep / 周期 tick-report / command-wake 触发的 tick)。drop 以
  // gugu_user_id(= reporter 拿到的 agentUserId)本身就是这一行的身份,直接按它删。
  // #5331 例外:公网身份**还在飞**的行不是「别处删了」,是还没铸出来。守卫的前提(名册有行 ⇒ 云端
  // 必然有过对应行)在本地优先铸身份之后不再成立,而这里删掉的正是一条刚起、正在用的会话的行。
  // fail-loud:跳过要说出来,否则「守卫没发作」和「守卫误删了」在日志里同形。
  // #6938 真删掉的行(只有它们,留下的在飞行不算)交给宿主:身份没了,宿主发给它的卡跟着作废。
  const dropLocalAgentByGuguUserId = async (agentUserId: string): Promise<void> => {
    if (!agentUserId) return
    const removed = await removeAgents(
      (agent) => {
        if (agent.gugu_user_id !== agentUserId) return false
        if (agentCloudIdentityPending(agent)) {
          options.warn?.(
            `[device-runtime] agent ${agentUserId} is not writable yet because its public identity is still ` +
              'being minted (#5331) — keeping the roster row; the runtime state will be reported on a later tick',
          )
          return false
        }
        return true
      },
      env,
    )
    for (const agent of removed) await options.onAgentRosterRemoved?.(agent, 'cloud-gone')
  }
  /**
   * presence 行的唯一写口:每一次写成功都记进「已发布过什么」。建 / 停 / 下线这类说不出读数的写记成没有读数,
   * 于是下一次边沿发布照常把真实读数补上(❌ 旧的去重表以为它已经发过)。
   */
  const makeRuntimeStateReporter = (client: DeviceRuntimeIdentityClient) => {
    const report = createAgentRuntimeStateReporter(
      client,
      { onGoneAgent: dropLocalAgentByGuguUserId },
      options.operationTimeouts,
    )
    return async (state: AgentRuntimeStateWrite): Promise<void> => {
      await report(state)
      publishedActivity.set(state.agentUserId, {
        activityStatus: state.activityStatus,
        reading: state.agentStatus ? { status: state.agentStatus, detail: state.agentStatusDetail ?? null } : null,
      })
    }
  }

  function unsubscribeCommandWake(): void {
    commandWake?.unsubscribe()
    commandWake = null
    wakeSubscribed = false
    commandWakeEpoch += 1
  }

  function unsubscribeDeviceRpc(): void {
    deviceRpc?.unsubscribe()
    deviceRpc = null
  }

  async function establishOwnerBoundary(ownerUserId: string): Promise<void> {
    if (persistedOwnerUserId === undefined) {
      persistedOwnerUserId = await readDeviceRuntimeOwner(env)
    }
    const previousOwnerUserId = activeOwnerUserId ?? persistedOwnerUserId
    if (previousOwnerUserId !== null && previousOwnerUserId !== ownerUserId) {
      unsubscribeCommandWake()
      unsubscribeDeviceRpc()
      if (activeHeartbeat) await activeHeartbeat
      await clearLocalAgentRuntimesForOwnerChange({
        env,
        runtimeBridge: options.runtimeBridge,
        onAgentRosterRemoved: options.onAgentRosterRemoved,
        ownerUserId,
      })
      localAgentsOnlineSwept = false
      runtimeSessionsAccessToken = null
      runtimeSessionsRetryAt = 0
      // 上一个身份的队列取空过,不说明下一个身份的队列是空的。
      queueBelievedEmpty = false
      clearUnannouncedVerdict()
      scheduledTasksPlanned = false
      clearScheduledTasksTimer()
      lastActivityReconcileAt = null
      lastOrphanRecoveryAt = null
      lastHeartbeatAt = null
      lastLeaseRenewAt = null
      lastLegacyCleanupAt = null
      lastDeviceId = null
      // #3961 —— 上一个身份「已发布过什么」不属于下一个人:留着会让新 owner 的第一轮对账把旧账当成现状
      // (该写的不写、不该写的写)。与上面那批 latch 同一处重置。
      publishedActivity.clear()
      publishedRecentActions.clear()
    }
    if (persistedOwnerUserId !== ownerUserId) {
      await writeDeviceRuntimeOwner(ownerUserId, env)
      persistedOwnerUserId = ownerUserId
    }
    const previousActive = activeOwnerUserId
    activeOwnerUserId = ownerUserId
    if (previousActive !== ownerUserId && options.onOwnerEstablished) {
      try {
        await options.onOwnerEstablished(ownerUserId, previousActive)
      } catch (error) {
        options.warn?.(`onOwnerEstablished failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function ensureDeviceRpc(deviceId: string, accessToken: string, generation: number): Promise<void> {
    if (!options.subscribeDeviceRpc) return
    if (generation !== lifecycleGeneration) return
    if (deviceRpc?.deviceId === deviceId && deviceRpc.accessToken === accessToken) return
    unsubscribeDeviceRpc()
    const unsubscribe = await options.subscribeDeviceRpc({ deviceId, accessToken })
    if (generation !== lifecycleGeneration) {
      unsubscribe()
      return
    }
    deviceRpc = { deviceId, accessToken, unsubscribe }
  }

  // 一次「该取命令了」的请求。没有 tick 在飞就立刻跑一轮;有就排一个后续的 ——
  // ❌ 不能只是旁观在飞的那一轮:它取命令的时刻早于这次事件。
  function requestCommandWake(): Promise<void> {
    if (!ticking) return tickOnce('event').then(() => undefined)
    if (!queuedCommandWake) {
      let resolveQueued!: () => void
      let rejectQueued!: (reason: unknown) => void
      const promise = new Promise<void>((resolve, reject) => {
        resolveQueued = resolve
        rejectQueued = reject
      })
      queuedCommandWake = {
        promise,
        resolve: resolveQueued,
        reject: rejectQueued
      }
    }
    return queuedCommandWake.promise
  }

  let deviceRemovedNotified = false
  let machineLimitWarned = false

  function writeHeartbeatSingleFlight(
    client: DeviceHeartbeatTableClient,
    heartbeatOptions: DeviceHeartbeatOptions,
    heartbeatEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    const active = heartbeatFlights.get(heartbeatOptions.userId)
    if (active) return active
    const flight = syncDeviceHeartbeat(client, heartbeatOptions, heartbeatEnv).catch((error: unknown) => {
      // #6264 这台机器已被账号主人在「设置 → 设备」里移除:库拒收它的心跳(DEVICE_REMOVED)。
      // 只通知一次,由宿主决定怎么收场(server 退出这个账号的登录)。错误照旧抛出,心跳本身按失败处理。
      if (!deviceRemovedNotified && isDeviceRemovedError(error)) {
        deviceRemovedNotified = true
        try {
          options.onDeviceRemoved?.((error as Error).message)
        } catch (callbackError) {
          options.warn?.(`[device-runtime] onDeviceRemoved threw: ${(callbackError as Error).message}`)
        }
      }
      // #6264 这个账号的咕咕 server 数到上限了(库拒收这台的第一次心跳,DEVICE_LIMIT_REACHED)。
      // 说成人话打一次,❌ 每 30 秒刷一遍同一句;心跳照旧按失败处理,移除一台 / 升级后下一拍自然接上。
      const refusal = machineLimitRefusalFromError(error)
      if (refusal && !machineLimitWarned) {
        machineLimitWarned = true
        options.warn?.(`[device-runtime] 这台机器没能加入账号:${machineLimitMessage(refusal)}${MACHINE_LIMIT_NEXT_STEP}`)
      }
      throw error
    }).finally(() => {
      if (heartbeatFlights.get(heartbeatOptions.userId) === flight) {
        heartbeatFlights.delete(heartbeatOptions.userId)
      }
    })
    heartbeatFlights.set(heartbeatOptions.userId, flight)
    return flight
  }

  async function ensureCommandWake(deviceId: string, accessToken: string, generation: number): Promise<void> {
    if (!options.subscribeCommandWake) return
    if (generation !== lifecycleGeneration) return
    if (commandWake?.deviceId === deviceId && commandWake.accessToken === accessToken) return
    unsubscribeCommandWake()
    const wakeEpoch = commandWakeEpoch
    let failed = false
    const unsubscribe = await options.subscribeCommandWake({
      deviceId,
      accessToken,
      onCommand: async (commandId) => {
        if (wakeEpoch !== commandWakeEpoch || generation !== lifecycleGeneration) return
        noteCommandAnnouncement(commandId)
        await requestCommandWake()
      },
      onSubscribed: () => {
        if (wakeEpoch !== commandWakeEpoch || generation !== lifecycleGeneration) return
        wakeSubscribed = true
        wakeSubscribeFailures = 0
      },
      onSubscriptionLost: () => {
        if (wakeEpoch !== commandWakeEpoch || generation !== lifecycleGeneration) return
        wakeSubscribed = false
        // 刚取到的「没被通知的行」有了解释:频道当时就是断的。
        clearUnannouncedVerdict()
      },
      onSubscribeFailure: () => {
        failed = true
        if (wakeEpoch !== commandWakeEpoch || generation !== lifecycleGeneration) return
        if (commandWake?.deviceId === deviceId && commandWake.accessToken === accessToken) {
          unsubscribeCommandWake()
        }
        onCommandWakeSubscribeFailed(generation)
      }
    })
    // @@@subscribe-failure-gap - A failure can fire before commandWake is assigned; this branch owns cleanup for that gap.
    if (failed || generation !== lifecycleGeneration) {
      unsubscribe()
      return
    }
    commandWake = { deviceId, accessToken, unsubscribe }
  }

  // wake 是新命令的事件源。订不上不致命(入队的行是持久的,订上时的补拉与对账节拍都会把它们取回),但必须响亮,
  // 而且订阅失败本身就是一个事件:❌ 不等下一个对账节拍才重订,退避着当场再来。
  const WAKE_SUBSCRIBE_FAILURE_ESCALATE_AT = 3
  function onCommandWakeSubscribeFailed(generation: number): void {
    wakeSubscribeFailures += 1
    if (wakeSubscribeFailures === WAKE_SUBSCRIBE_FAILURE_ESCALATE_AT) {
      options.warn?.(
        `[device-runtime] command wake failed to subscribe ${wakeSubscribeFailures} times in a row — ` +
          'new device commands reach this device only on the reconcile beat ' +
          `(every ${Math.round(superviseIntervalMs / 1000)} s) until the realtime subscription succeeds`,
      )
    }
    armWorkTickAfter(
      Math.min(intervalMs * 2 ** (wakeSubscribeFailures - 1), superviseIntervalMs),
      generation,
    )
  }

  function tickOnce(trigger: DeviceRuntimeTickTrigger = 'event'): Promise<DeviceRuntimeHostTickResult> {
    // Concurrent callers observe the same flight. Returning a synthetic skipped success loses both
    // the eventual result and any failure that explains why the channel was occupied.
    if (ticking) return activeTick!
    // 本轮接替旧的跟进请求;本轮期间新挂的 wake 重试必须保留,不能在取空时一起清掉(#5979)。
    clearDrainFollowUp()
    heartbeatCapabilityTimedOut = false
    ticking = true
    const generation = lifecycleGeneration
    const abortController = new AbortController()
    activeTickAbortController = abortController
    const tick = runTickOnce(generation, abortController.signal, trigger).finally(() => {
      if (activeTick === tick) {
        activeTick = null
        activeTickAbortController = null
      }
    })
    activeTick = tick
    return tick
  }

  // @@@auth-expired-once - PERMANENT auth loss (RuntimeAuthExpiredError) is terminal: the provider has
  function handleAuthExpired(err: unknown): boolean {
    if (!(err instanceof RuntimeAuthExpiredError)) return false
    if (!authExpired) {
      authExpired = true
      const message = `[device-runtime] auth permanently lost — device needs re-login: ${err.message}`
      options.warn?.(message)
      options.onAuthExpired?.(message)
    }
    return true
  }

  // @@@pre-claim-phases — 一轮 tick 从开始到认领命令,每一段各花多久。只在总时长超过 intervalMs 时说一句:
  // intervalMs 是宿主自己对「pending 的行最迟多久再看一眼」的约定(排空跟进的间隔),认领之前就耗掉比它还久,
  // 等着的那条消息就晚过了宿主自己的复查节律。10-22 一次重启后这一段拖到 20–66 s,当时日志里没有一行能还原它。
  function startPreClaimTimer(trigger: DeviceRuntimeTickTrigger): { mark: (phase: string) => void } {
    const startedAt = nowMs()
    const phases: string[] = []
    let last = startedAt
    const mark = (phase: string): void => {
      const at = nowMs()
      phases.push(`${phase} ${at - last} ms`)
      last = at
      if (phase !== 'claim' || at - startedAt <= intervalMs) return
      options.warn?.(`[device-runtime] ${trigger} tick reached the claim after ${at - startedAt} ms: ${phases.join(', ')}`)
    }
    return { mark }
  }

  async function runTickOnce(
    generation: number,
    signal: AbortSignal,
    trigger: DeviceRuntimeTickTrigger,
  ): Promise<DeviceRuntimeHostTickResult> {
    announcedDuringTick.clear()
    blanketAnnouncementDuringTick = false
    const preClaim = startPreClaimTimer(trigger)
    try {
      const auth = await options.authProvider.getAuth()
      if (!auth?.accessToken || !auth.userId) {
        unsubscribeCommandWake()
        unsubscribeDeviceRpc()
        lastAuth = null
        lastTickAt = nowMs()
        queueBelievedEmpty = false
        return { skipped: true }
      }
      await establishOwnerBoundary(auth.userId)
      lastAuth = auth
      lastError = null
      // @@@activity-edge (#3961/#4008) — 逐 agent 的维护与边沿发布都在 activity 的 flight 上跑(见 maintainLocalAgents),
      // ❌ 不在这条认领命令的 tick 上。这里只保证「刚拿到鉴权就先说一次」。
      scheduleActivityPublish()
      preClaim.mark('auth')
      const client = options.makeIdentityClient(auth.accessToken)
      const currentTime = nowMs()
      const syncHeartbeat =
        lastHeartbeatAt === null || currentTime - lastHeartbeatAt >= heartbeatIntervalMs
      // @@@5912 租约在**一个跳过窗口**内被任何一条腿续过 ⇒ tick 不必再续一次。
      // ❌ 只记独立那条腿是不够的:那样每个对账 tick 都会自己续,而对账节拍比续租周期密一个数量级。
      // 判据问的是「租约新不新鲜」,不是「谁续的」。
      // ⚠️ 窗口**显式夹在租约 TTL 的一半以内**,不靠「续租周期恰好是 30 s」这个巧合:
      // heartbeatIntervalMs 是公开可注入的选项,谁把它调到 ≥ 90 s,这里就会放一个**已经过期**的租约去认领命令,
      // 而兄弟实例的孤儿恢复会把这台正在跑的命令收走重跑(@@@1676 要防的正是这件事)。
      const leaseSkipWindowMs = Math.min(heartbeatIntervalMs, RUNTIME_INSTANCE_STALE_MS / 2)
      const leaseRenewalFresh =
        lastLeaseRenewAt !== null && currentTime - lastLeaseRenewAt < leaseSkipWindowMs
      // @@@5912 一台机器在**一个 owner** 下只有一个设备 id,它不会在一次身份期内改口。
      // 此前每一轮对账 tick 都整解析一遍,而解析里有一次云端 `GET gugu_devices`(identity lookup):
      // 空闲时每 30 秒一个请求,问的是上一拍刚答过、且不可能改口的问题。
      // 换 owner 时 establishOwnerBoundary 会清掉 lastDeviceId ⇒ 下一轮自然重解析。
      const deviceId = lastDeviceId ?? await resolveLocalDeviceId({
        env,
        userId: auth.userId,
        heartbeatClient: client,
        machineIdentifier: options.machineIdentifier,
        deviceIdCacheWriter: options.deviceIdCacheWriter,
        operationTimeouts: options.operationTimeouts,
      })
      // 解析成功的当下就写进快照(调试快照读它),命令执行发生在本 tick **内部**。
      lastDeviceId = deviceId
      // 先订设备 RPC,再写心跳:设备行里出现这台(心跳带 app_version)就等于它已经接得了 RPC。看到机器上线 / 换完版
      // 就去开线的路径(会话页的机器线)发来的请求是 broadcast,频道还没订上就直接丢了,只能等它超时。
      await ensureDeviceRpc(deviceId, auth.accessToken, generation)
      preClaim.mark('device-rpc')
      let heartbeatSynced = false
      if (syncHeartbeat) {
        try {
          await writeHeartbeatSingleFlight(
            client,
            {
              userId: auth.userId,
              deviceId,
              nowIso: options.nowIso,
              capabilities: options.capabilities,
              sessionDigest: options.sessionDigest,
              deviceActions: options.deviceActions,
              label: options.label,
              capabilityTimeoutMs: options.capabilityTimeoutMs,
              machineIdentifier: options.machineIdentifier,
              deviceIdCacheWriter: options.deviceIdCacheWriter,
              operationTimeouts: options.operationTimeouts,
            },
            env,
          )
          heartbeatSynced = true
        } catch (error) {
          if (error instanceof DeviceOperationTimeoutError) throw error
          if (error instanceof DeviceCapabilityTimeoutError) throw error
          options.warn?.(`[device-runtime] ${(error as Error).message}`)
        }
      }
      preClaim.mark('heartbeat')
      // @@@1676 — 周期性 orphan 恢复:首 tick + 每 orphanRecoveryIntervalMs 一次(实例归属保证不误清活兄弟)。
      const shouldRecoverOrphans = gateOpen(lastOrphanRecoveryAt, orphanRecoveryIntervalMs, currentTime)
      const reportRuntimeState = makeRuntimeStateReporter(client)
      const result = await runDeviceRuntimeTick(
        {
          userId: auth.userId,
          signal,
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken ?? null,
          commandClient: client,
          // 一轮 deliver 能跑得比 auth.accessToken 剩下的寿命还长(provider 只在离过期不到 60 s 时才换),
          // 所以落终态时重新问 provider 要令牌,❌ 用这一拍开头那个 client。
          resolveSettleClient: async () => {
            const current = await options.authProvider.getAuth()
            if (!current?.accessToken) throw new Error('device command settlement has no runtime auth')
            if (current.userId !== auth.userId) {
              throw new RuntimeAuthExpiredError(`device command settlement owner changed: claimed as ${auth.userId}, auth is now ${current.userId}`)
            }
            return options.makeIdentityClient(current.accessToken)
          },
          heartbeatClient: client,
          deviceId,
          nowIso: options.nowIso,
          capabilities: options.capabilities,
          sessionDigest: options.sessionDigest,
          deviceActions: options.deviceActions,
          label: options.label,
          capabilityTimeoutMs: options.capabilityTimeoutMs,
          machineIdentifier: options.machineIdentifier,
          deviceIdCacheWriter: options.deviceIdCacheWriter,
          operationTimeouts: options.operationTimeouts,
          instanceId,
          skipInstanceLeaseRenewal: leaseRenewalFresh,
          syncHeartbeat: false,
          recoverOrphanedCommands: shouldRecoverOrphans,
          onPhase: preClaim.mark,
          onHeartbeatError: (error) =>
            options.warn?.(`[device-runtime] ${(error as Error).message}`),
          runtimeBridge: options.runtimeBridge,
          reportRuntimeState: async (state) => {
            if (generation !== lifecycleGeneration) {
              throw new Error('device runtime tick was stopped before runtime state report')
            }
            await reportRuntimeState(state)
          },
          onRuntimeStateReportError: (error) =>
            options.warn?.(`[device-runtime] ${(error as Error).message}`),
          onAgentDeliverFailure: options.onAgentDeliverFailure,
        },
        env
      )
      await ensureCommandWake(result.deviceId, auth.accessToken, generation)
      // @@@scheduled-tasks (#987) — 定时任务由到期定时器驱动,❌ 不在 tick 里跑。tick 只负责本生命周期第一次确立 owner
      // 边界之后排第一次;周期重排挂在对账**定时器**上(见 start())—— 挂在 tick 上就是按事件频率扫表。
      if (!scheduledTasksPlanned) scheduleScheduledTasksRun()
      lastDeviceId = result.deviceId
      lastTickAt = currentTime
      if (shouldRecoverOrphans) lastOrphanRecoveryAt = currentTime
      if (heartbeatSynced) lastHeartbeatAt = currentTime
      // @@@5912 currentTime 是 tick **开始**时captured 的;一条 deliver 能让这一轮跑几分钟,
      // 期间独立续租那条腿已经把 lastLeaseRenewAt 推得更新了 —— 直接赋值会把它倒回去。取大者。
      if (!leaseRenewalFresh) lastLeaseRenewAt = Math.max(lastLeaseRenewAt ?? 0, currentTime)
      // @@@5912 legacy / 陈旧行清理从「每拍一次」降成一个**周期闸**,与孤儿恢复、activity 对账同一种形状。
      // ⚠️ 它**不是**「一次就够」:清理的判据本身带时间(同 hostname 的 legacy 行要租约过期 2 分钟、
      // 陈旧行要 30 天没上线),所以同一个 owner 下答案会随时间改口 —— 一台还活着的兄弟实例在本宿主
      // 第一轮时不够格,两分钟后它退出就够格了。锁死成「每个 owner 一次」会让那一行一直留在设备列表上
      // 直到 app 重启。⇒ 给它自己的节律,而不是取消它。
      // best-effort:它清的是历史垃圾,清不掉不该让这一轮 tick 失败;失败不推进闸,下一轮重试。
      if (gateOpen(lastLegacyCleanupAt, legacyCleanupIntervalMs, currentTime)) {
        try {
          await cleanupLegacyDeviceRows(client, result.deviceId, {
            operationTimeouts: options.operationTimeouts,
          })
          lastLegacyCleanupAt = currentTime
        } catch (error) {
          options.warn?.(`[device-runtime] legacy device cleanup: ${(error as Error).message}`)
        }
      }
      workFailureStreak = 0
      // @@@not-mine (#5041) — `held-elsewhere` 的行归那台活着的兄弟实例(它有自己的跟进):本实例不为它续跑(否则兄弟的
      // 长回合期间本实例每 intervalMs 空取一轮)、不算进「队列非空」、不为它告警(兄弟 hold 回 pending 是 UPDATE,本无广播)。
      const mine = result.commands.filter((command) => command.reason !== 'held-elsewhere')
      reportUnannouncedCommands(trigger, mine, result.recoveredOrphans, generation)
      queueBelievedEmpty = mine.length === 0
      armDrainFollowUp(mine, generation)
      return { skipped: false, deviceId: result.deviceId, commands: result.commands }
    } catch (err) {
      lastError = (err as Error).message
      lastTickAt = nowMs()
      if (signal.aborted && generation !== lifecycleGeneration) {
        return { skipped: true }
      }
      // PERMANENT auth loss: drop subscriptions, raise the distinct one-time signal, and end the tick
      // cleanly (skipped) instead of re-throwing a spin-y error every interval.
      if (handleAuthExpired(err)) {
        unsubscribeCommandWake()
        unsubscribeDeviceRpc()
        lastAuth = null
        queueBelievedEmpty = false
        return { skipped: true }
      }
      options.warn?.(`[device-runtime] ${(err as Error).message}`)
      // 一轮 tick 失败 = 队列此刻什么样**不知道**(孤儿恢复可能已经把行放回去了、取命令却没做成)。
      // 这不是「没有事件」,是一次没做完的尝试 ⇒ 退避重试,上限一个对账周期。
      queueBelievedEmpty = false
      armWorkRetry(generation)
      throw err
    } finally {
      const queued = queuedCommandWake
      queuedCommandWake = null
      ticking = false
      if (queued) {
        // 判「还要不要跑」看宿主此刻是不是在跑,❌ 不看这一轮属于哪一代:stop() 超时之后紧接着 start() 时,新生命周期的
        // 首轮就排在这条旧 tick 后面 —— 按代数丢掉它,新宿主要到下一个对账节拍才有第一轮。
        if (stopped) {
          queued.resolve()
        } else {
          void tickOnce('event').then(queued.resolve, queued.reject)
        }
      }
    }
  }

  function clearDrainFollowUp(): void {
    if (drainFollowUpTimer !== null) clearTimeout(drainFollowUpTimer)
    drainFollowUpTimer = null
  }

  // 「最迟什么时候要再跑一轮」只有一个槽,三种来由共用(排空跟进 / 失败重试 / wake 重订)⇒ 留**更早**的那个期限:
  // 一次 30 s 的重订退避不许把一条 2 s 的排空跟进顶掉。
  function armWorkTickAfter(delayMs: number, generation: number): void {
    // 只有长跑中的宿主才自己续跑;单次 tickOnce() 的调用方(测试、一次性脚本)不该被留下一个定时器。
    if (superviseTimer === null || stopped || generation !== lifecycleGeneration) return
    const dueAt = Date.now() + delayMs
    if (drainFollowUpTimer !== null && drainFollowUpDueAt <= dueAt) return
    clearDrainFollowUp()
    drainFollowUpDueAt = dueAt
    drainFollowUpTimer = setTimeout(() => {
      drainFollowUpTimer = null
      scheduleWorkTick()
    }, delayMs)
  }

  // @@@drain-follow-up — 取到的行非空就再跑一轮,直到取空。留在 pending 的行(held / unheld / holding-unknown /
  // 超出公平配额的余量)没有任何事件会替它们叫醒宿主,只能由这条跟进复查;取空 = 静默,不再为命令发请求。
  // 有行落了终态或转入 deferred = 有进展 ⇒ 立刻接着排;一条都没动 ⇒ 隔 intervalMs,免得对着 held 的行空转。
  function armDrainFollowUp(commands: readonly ProcessDeviceCommandResult[], generation: number): void {
    if (commands.length === 0) return
    const progressed = commands.some(
      (command) => command.status === 'done' || command.status === 'error' || command.status === 'deferred',
    )
    armWorkTickAfter(progressed ? 0 : intervalMs, generation)
  }

  function armWorkRetry(generation: number): void {
    workFailureStreak += 1
    armWorkTickAfter(Math.min(intervalMs * 2 ** (workFailureStreak - 1), superviseIntervalMs), generation)
  }

  // @@@reconcile-is-an-instrument — 对账取到了行,而上一轮取空、这一轮孤儿恢复也没放回行 ⇒ 这些行没被任何事件通知过
  // (广播丢了,或别处 UPDATE 放回而没通知本机)。这条告警的频率就是事件通道的丢失率,❌ 不许被对账悄悄抹平。
  // 不许误报:wake 没订着不判(那是订阅的事);通知按行 id 对,这一轮期间与之后一个 intervalMs 内到场的都算数
  // —— INSERT 刚提交时,对账的取与广播谁先到不一定。
  function reportUnannouncedCommands(
    trigger: DeviceRuntimeTickTrigger,
    commands: readonly ProcessDeviceCommandResult[],
    recoveredOrphans: number,
    generation: number,
  ): void {
    if (trigger !== 'reconcile' || !queueBelievedEmpty || !wakeSubscribed || blanketAnnouncementDuringTick) return
    if (recoveredOrphans > 0) return
    if (superviseTimer === null || stopped || generation !== lifecycleGeneration) return
    const silent = commands.filter((command) => !announcedDuringTick.has(command.commandId))
    if (silent.length === 0) return
    const pending = unannouncedVerdict?.pending ?? new Map<string, string>()
    clearUnannouncedVerdict()
    for (const command of silent) pending.set(command.commandId, `${command.type}:${command.commandId}`)
    const timer = setTimeout(() => {
      unannouncedVerdict = null
      options.warn?.(
        `[device-runtime] reconcile found ${pending.size} pending device command(s) that no wake event announced ` +
          `(${[...pending.values()].join(', ')}) — a command_created broadcast was lost, or a row was put back to pending without notifying this device`,
      )
    }, intervalMs)
    unannouncedVerdict = { pending, timer }
  }

  function clearUnannouncedVerdict(): void {
    if (unannouncedVerdict) clearTimeout(unannouncedVerdict.timer)
    unannouncedVerdict = null
  }

  // 外部的「有行变成 pending 了」:wake 频道的事件(广播点名一行;订上时的补拉是泛指)与本机的 notifyCommandsChanged(泛指)。
  // 宿主自己发起的轮次(排空跟进、重试)不算通知。
  function noteCommandAnnouncement(commandId?: string): void {
    if (commandId === undefined) {
      blanketAnnouncementDuringTick = true
      clearUnannouncedVerdict()
      return
    }
    announcedDuringTick.add(commandId)
    if (unannouncedVerdict?.pending.delete(commandId) && unannouncedVerdict.pending.size === 0) clearUnannouncedVerdict()
  }

  function clearScheduledTasksTimer(): void {
    if (scheduledTasksTimer !== null) clearTimeout(scheduledTasksTimer)
    scheduledTasksTimer = null
  }

  // @@@scheduled-tasks-driver (#987/#5906) — 事实是「最早的到期时刻」,所以驱动它的是挂在那个时刻上的一次性定时器,
  // ❌ 不是任何周期。本轮到期却没推进成排期的任务不参与挂表(见 nextDueAtMs),由对账的重排补触发。
  function scheduleScheduledTasksRun(): void {
    if (!options.runScheduledTasks || stopped || activeScheduledTasksRun) return
    scheduledTasksPlanned = true
    const generation = lifecycleGeneration
    const run = runScheduledTasksOnce(generation).finally(() => {
      if (activeScheduledTasksRun === run) activeScheduledTasksRun = null
    })
    activeScheduledTasksRun = run
  }

  async function runScheduledTasksOnce(generation: number): Promise<void> {
    try {
      const auth = await options.authProvider.getAuth()
      if (!auth?.accessToken || !auth.userId) return
      if (generation !== lifecycleGeneration || stopped) return
      // 身份边界未确立之前不跑:owner 还没被 tick 认定时,扫到的可能是上一个人的任务。
      if (activeOwnerUserId !== auth.userId) return
      const { nextDueAtMs } = await options.runScheduledTasks!({
        ownerUserId: auth.userId,
        accessToken: auth.accessToken,
        nowMs: nowMs(),
        deviceId: lastDeviceId,
      })
      if (generation !== lifecycleGeneration || stopped) return
      clearScheduledTasksTimer()
      if (nextDueAtMs === null || superviseTimer === null) return
      // setTimeout 的上限约 24.8 天;更远的到期时刻由监督 tick 的重排逐步逼近。
      const delayMs = Math.min(Math.max(0, nextDueAtMs - nowMs()), 2 ** 31 - 1)
      scheduledTasksTimer = setTimeout(() => {
        scheduledTasksTimer = null
        scheduleScheduledTasksRun()
      }, delayMs)
    } catch (error) {
      if (handleAuthExpired(error)) return
      options.warn?.(`[device-runtime] scheduled-tasks: ${(error as Error).message}`)
    }
  }

  // @@@independent-lease — 租约(90 s 过期)❌ 不能做 tick 的人质:一条 deliver 被 tick await 着跑几分钟,期间单飞的 tick
  // 一轮都进不来,租约一过期兄弟实例就会把这台**正在跑**的命令当孤儿收走再跑一遍。也 ❌ 不与设备心跳共用 flight ——
  // 心跳的能力探测超时会落一个只有新 tick 才能清的闩,而此刻恰恰没有新 tick。续租只是一条 RPC,不依赖能力探测。
  async function renewInstanceLeaseOnce(): Promise<void> {
    if (stopped || !lastDeviceId) return
    const generation = lifecycleGeneration
    try {
      const auth = await options.authProvider.getAuth()
      if (!auth?.accessToken || !auth.userId) return
      if (generation !== lifecycleGeneration || stopped || activeOwnerUserId !== auth.userId || !lastDeviceId) return
      const reading = await reportRuntimeInstanceHeartbeat(
        options.makeIdentityClient(auth.accessToken),
        instanceId,
        lastDeviceId,
        options.operationTimeouts,
      )
      lastLeaseRenewAt = nowMs()
      reportDeviceLeaseSweepAge(reading)
    } catch (error) {
      if (handleAuthExpired(error)) return
      options.warn?.(`[device-runtime] instance lease: ${(error as Error).message}`)
    }
  }

  // @@@5912 「设备离线」那个边沿由库里全局唯一的清扫者产生。它停了会**静默**地让所有设备永远显示在线 ——
  // 库里的读时闸(命令插入 RLS、presence payload)仍按租约求值,所以新鲜读不会错,错的是各客户端的缓存;
  // 而缓存错了没有任何人会报错。⇒ 由依赖它的这一侧说出来。阈值取一个完整的租约 TTL。
  // ❌ 不在客户端加「到点自己变暗」的兜底定时器 —— 那会把这个故障盖住。
  function reportDeviceLeaseSweepAge(reading: RuntimeInstanceHeartbeatReading): void {
    const ageSeconds = reading.deviceLeaseSweepAgeSeconds
    if (ageSeconds !== null && ageSeconds * 1000 <= DEVICE_ONLINE_STALE_MS) return
    options.warn?.(
      `[device-runtime] device lease sweeper is not running (last run ${
        ageSeconds === null ? 'unknown — the bookkeeping row is gone' : `${ageSeconds}s ago`
      }); offline devices will keep showing as online on every client until it comes back`,
    )
  }

  function scheduleLeaseRenewal(): void {
    if (activeLeaseRenewal) return
    const renewal = renewInstanceLeaseOnce().finally(() => {
      if (activeLeaseRenewal === renewal) activeLeaseRenewal = null
    })
    activeLeaseRenewal = renewal
  }

  // @@@independent-heartbeat - device liveness must not be hostage to the work tick. A long
  async function heartbeatOnce(): Promise<void> {
    if (stopped) return
    const generation = lifecycleGeneration
    try {
      const auth = await options.authProvider.getAuth()
      if (!auth?.accessToken || !auth.userId) return
      if (generation !== lifecycleGeneration || stopped) return
      if (activeOwnerUserId !== auth.userId) return
      const client = options.makeIdentityClient(auth.accessToken)
      await writeHeartbeatSingleFlight(
        client,
        {
          userId: auth.userId,
          deviceId: lastDeviceId ?? undefined,
          nowIso: options.nowIso,
          capabilities: options.capabilities,
          sessionDigest: options.sessionDigest,
          deviceActions: options.deviceActions,
          label: options.label,
          capabilityTimeoutMs: options.capabilityTimeoutMs,
          machineIdentifier: options.machineIdentifier,
          deviceIdCacheWriter: options.deviceIdCacheWriter,
          operationTimeouts: options.operationTimeouts,
        },
        env
      )
      lastHeartbeatAt = nowMs()
    } catch (error) {
      // The independent heartbeat is where stale-online would otherwise hide: surface a permanent
      // auth loss here too (once), so the device can't keep heartbeating-then-failing in silence.
      if (handleAuthExpired(error)) return
      if (error instanceof DeviceCapabilityTimeoutError) heartbeatCapabilityTimedOut = true
      options.warn?.(`[device-runtime] heartbeat: ${(error as Error).message}`)
    }
  }

  // @@@1137 调度 tick 的可观测性:runTickOnce 已对每次逃逸错误 options.warn(逐 tick 明细) 再 rethrow,
  // 失败并非「零日志」。此处的 catch 故意不重复 warn(否则每 tick 双刷日志 = regression);改为具名
  // 处理 + 「连续失败到阈值」补一条升级健康信号 → 持续卡死的 cloud agent 可观测(对应 issue「挂了无
  // 可观测」),且 setInterval 不被一次失败撕掉。成功(非 skipped)即清零;非裸 () => {} 静默吞。
  const TICK_FAILURE_ESCALATE_AT = 3
  let consecutiveTickFailures = 0
  let scheduledTickObserver: Promise<DeviceRuntimeHostTickResult> | null = null
  function onScheduledTickResolved(result: DeviceRuntimeHostTickResult): void {
    if (!result.skipped) consecutiveTickFailures = 0
  }
  function onScheduledTickRejected(err: unknown): void {
    // 逐 tick 明细已由 runTickOnce warn;这里只在连续失败到阈值时升级一次(避免风暴刷日志)。
    consecutiveTickFailures += 1
    if (consecutiveTickFailures === TICK_FAILURE_ESCALATE_AT) {
      options.warn?.(
        `[device-runtime] tick failed ${consecutiveTickFailures} times consecutively; cloud agent may be stalled (latest: ${(err as Error)?.message ?? String(err)})`,
      )
    }
  }
  function observeScheduledTick(tick: Promise<DeviceRuntimeHostTickResult>): void {
    if (scheduledTickObserver === tick) return
    scheduledTickObserver = tick
    void tick
      .then(onScheduledTickResolved, onScheduledTickRejected)
      .finally(() => {
        if (scheduledTickObserver === tick) scheduledTickObserver = null
      })
  }

  // 宿主自己发起的一轮(启动 / 排空跟进 / 失败重试 / 登录态变化 / 本机放回了行)。有 tick 在飞就排一个后续的,
  // 与 wake 事件走同一个入口 —— ❌ 不旁观在飞的那一轮:它取命令的时刻早于这次事件。
  function scheduleWorkTick(): void {
    if (stopped) return
    if (!ticking) {
      observeScheduledTick(tickOnce('event'))
      return
    }
    void requestCommandWake().catch(() => undefined)
  }

  function scheduleReconcileTick(): void {
    // 有 tick 在飞,这一拍就不必再跑:在飞的那一轮做的是同样的事。
    if (stopped || ticking) return
    observeScheduledTick(tickOnce('reconcile'))
  }

  function scheduleHeartbeat(): void {
    if (activeHeartbeat || heartbeatCapabilityTimedOut) return
    const heartbeat = heartbeatOnce().finally(() => {
      if (activeHeartbeat === heartbeat) activeHeartbeat = null
    })
    activeHeartbeat = heartbeat
  }

  function notifyDeviceActionsChanged(): void {
    if (stopped || heartbeatTimer === null) return
    // The heartbeat in flight may have read the list before the change: one more once it is written.
    if (activeHeartbeat) void activeHeartbeat.finally(() => scheduleHeartbeat())
    else scheduleHeartbeat()
  }

  // #4008 —— activity 的发布节律。与 work tick 同频,但**不与它共用 flight**:回合期间 work flight 是
  // pending 的,而正在跑的那个回合恰恰就是此刻唯一值得说出口的事实。单飞只防自己叠自己;鉴权由 provider
  // 自己缓存,这里不额外持有。best-effort:失败只告警,下一轮重来(publishedActivity 未记录 ⇒ 自动重试)。
  function scheduleActivityPublish(): void {
    if (stopped) return
    // A state-change notification can arrive while the previous publish is awaiting the
    // identity write. Keep one follow-up request so a terminal transition cannot be lost.
    if (activeActivityPublish) {
      activityPublishQueued = true
      return
    }
    const generation = lifecycleGeneration
    const publish = publishAgentActivityOnce(generation).finally(() => {
      if (activeActivityPublish !== publish) return
      activeActivityPublish = null
      if (activityPublishQueued) {
        activityPublishQueued = false
        scheduleActivityPublish()
      }
    })
    activeActivityPublish = publish
  }

  // 逐个本机 agent 的维护,从认领命令的那条 tick 上搬到这里(activity 的 flight):三件事都随 agent 数线性增长,
  // 放在 tick 里就排在认领前面。令牌用 tick 最近一次拿到的 lastAuth,❌ 每 2 秒去问一次 provider。
  // 没做成的那一件按对账节拍重试 —— 从前它随 tick 重试,❌ 搬到 2 秒一轮的 flight 上就变成每 2 秒整批重来一遍。
  async function maintainLocalAgents(generation: number): Promise<void> {
    const auth = lastAuth
    if (!auth?.accessToken || auth.userId !== activeOwnerUserId) return
    // @@@push-fresh-session - owner 的 GoTrue 会话每次续期都轮换,本机 agent 的令牌档跟着换;令牌没变就没有要写的。
    // 有一档没写成就不记账,稍后整批重写。新建的 agent 由 provisioning 自己写它那一档。
    if (auth.accessToken !== runtimeSessionsAccessToken && nowMs() >= runtimeSessionsRetryAt) {
      const synced = await syncAgentRuntimeSessions({
        env,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken ?? null,
        ownerUserId: auth.userId,
      })
      if (synced) runtimeSessionsAccessToken = auth.accessToken
      else runtimeSessionsRetryAt = nowMs() + superviseIntervalMs
    }
    // @@@1528 - device runtime ready → proactively mark this device's local agents online so they don't
    // show 假离线 until messaged. @@@1663 只在 sweep **干净全成功**后才 latch:没成就按对账节拍重扫
    // (reportRuntimeState online 幂等,重扫已上线者无害),运行中的 host 自愈、无需重启。
    // @@@activity-reconcile — latch 之后按 activityReconcileIntervalMs 周期对账,纠正卡死的 running 行。
    const sweepEveryMs = localAgentsOnlineSwept ? activityReconcileIntervalMs : superviseIntervalMs
    if (!gateOpen(lastActivityReconcileAt, sweepEveryMs, nowMs())) return
    lastActivityReconcileAt = nowMs()
    await pruneStaleGuestRecords({ env })
    if (await markLocalRuntimeAgentsOnline(auth, generation)) localAgentsOnlineSwept = true
  }

  async function publishAgentActivityOnce(generation: number): Promise<void> {
    try {
      // 身份边界未确立之前不写:owner 还没被 tick 认定时,写出去的行可能属于上一个人。
      if (!activeOwnerUserId) return
      await maintainLocalAgents(generation)
      await publishLocalAgentActivity(generation)
    } catch (error) {
      if (handleAuthExpired(error)) return
      options.warn?.(
        `[device-runtime] activity publish failed: ${String((error as Error)?.message ?? error)}`,
      )
    }
  }

  function start(): void {
    if (superviseTimer !== null) return
    if (!options.subscribeCommandWake) {
      // 宿主不轮询命令。没有事件源 = 启动之后再也收不到任何新命令,而且一声不响 —— 当场拒绝比静默变聋好。
      throw new Error(
        'device runtime host cannot start without subscribeCommandWake: commands are event-driven, ' +
          'a host with no wake source would never receive a new command',
      )
    }
    stopped = false
    // ⚠️ 先装监督节拍再发首轮:首轮 tick 结尾的排空跟进以「监督节拍已装上」判定宿主在长跑。
    superviseTimer = setInterval(() => {
      scheduleReconcileTick()
      // 定时任务的周期重排:别的设备改了任务,最迟一个监督周期内在这台设备上生效。
      if (scheduledTasksPlanned) scheduleScheduledTasksRun()
    }, superviseIntervalMs)
    scheduleWorkTick()
    heartbeatTimer = setInterval(() => {
      scheduleLeaseRenewal()
      scheduleHeartbeat()
    }, heartbeatIntervalMs)
    activityTimer = setInterval(scheduleActivityPublish, intervalMs)
    // 读数一变就宣告(宿主按 agent 的流)→ 立刻发布一次,不等下一格节律。
    unsubscribeAgentTurnState ??= options.runtimeBridge?.onAgentStatusChanged?.(() => {
      scheduleActivityPublish()
    }) ?? null
  }

  // @@@1528 - device-runtime-ready → proactively report this device's local agents online/idle.
  // Presence was activity-driven (an agent only reported online when its ACP session lazily spawned
  // on the first delivered message), so a logged-in device's existing agents showed 假离线 until messaged. Marking them
  // online/idle at runtime-ready makes presence device-ready-driven. Online is still gated by the
  // device heartbeat freshness (deriveAgentReachability.deviceOnline), so a disconnected device
  // still shows its agents offline. Best-effort, per-agent isolated — never breaks the tick.
  // Runs once per host lifecycle (login/restart). No engine spawn (idle), so no running-state clobber.
  // @@@1663 返回「本次是否干净全成功」(所有本机 agent 都成功标 online、无 generation/stop race)。仅返回
  // true 时调用方才 latch localAgentsOnlineSwept;失败/中途 race → false → 下个 authed tick 重扫,直到一次全成功。
  // @@@2151 gone-agent(别处删/e2e cleanup 删/非本 owner)的 online 写会命中 migration 036
  // `can_write_agent_runtime_state` 的「not writable」RAISE。守卫已**收口到 makeRuntimeStateReporter 单一
  // choke point**(gone→本地 drop + swallow),故此处不再自查 DB 存量 / 不再自己 drop:只喂候选、报真错误。
  // 纯逻辑(遍历/写/在飞跳过/bail)在 ./deviceRuntimeSweep(Node 可单测)。
  async function markLocalRuntimeAgentsOnline(auth: RuntimeAuth, generation: number): Promise<boolean> {
    try {
      const client = options.makeIdentityClient(auth.accessToken)
      const reportRuntimeState = makeRuntimeStateReporter(client)
      // #4277 别家账号的行留在名册里(它的主人回来要用),但不归本账号巡扫。
      const localAgents = agentsForOwner(await listAgents(env), auth.userId)
      // 候选:有 gugu_user_id、非 cloud(cloud agent 跑在云 cage,不在本机标 online)。
      const agentUserIds: string[] = []
      for (const agent of localAgents) {
        if (!agent.gugu_user_id) continue
        if (agent.agent_type === CLOUD_AGENT_TYPE) continue
        // #5331 公网身份还在飞 ⇒ 云端还没有这一行,这一发写必定被 RAISE 拒。跳过它省掉一发注定失败的
        // 往返;真正的保命闸在 dropLocalAgentByGuguUserId 那里(任何写点漏跳都不许删到在飞的行)。
        if (agentCloudIdentityPending(agent)) continue
        agentUserIds.push(agent.gugu_user_id)
      }
      return await sweepLocalAgentsOnline({
        agentUserIds,
        reportOnline: async (agentUserId, published) => {
          const recent = await recentActionsForAgent(agentUserId)
          await reportRuntimeState({
            agentUserId,
            runtimeStatus: 'online',
            ...presenceFields(published),
            runtimeKind: 'gugu',
            runtimeLabel: hostname(),
            recentActions: recent?.actions ?? null,
            lastActionAt: recent?.lastActionAt ?? null
          })
          publishedRecentActions.set(agentUserId, recentActionsKey(recent))
        },
        statusOf: agentStatusOf,
        // Bail if a stop()/re-login raced mid-sweep — never leave an agent stale-online after stop.
        shouldBail: () => generation !== lifecycleGeneration || stopped,
        warn: options.warn
      })
    } catch (error) {
      options.warn?.(`[device-runtime] startup online sweep failed: ${String((error as Error)?.message ?? error)}`)
      return false
    }
  }

  // @@@activity-edge (#3961) — 与 markLocalRuntimeAgentsOnline 同源同口径,区别只在:它是全量对账,
  // 这个是边沿触发。候选口径必须与那边一致(有 gugu_user_id、非 cloud),否则两者会互相写回对方的旧值。
  /**
   * 这个 agent 在本机的读数 —— presence 发布的唯一依据(spec agent-status-writer:会话页状态写入者 → 宿主按
   * agent 的流 → 这里)。❌ 再取投递命令的执行区间或传输自己的回合追踪做「或」:两个事实源迟早给出两个答案。
   */
  function agentStatusOf(agentUserId: string): AgentStatusReading | null {
    return options.runtimeBridge?.agentStatus?.(agentUserId) ?? null
  }

  function presenceFields(published: PublishedAgentStatus): Pick<AgentRuntimeStateWrite, 'activityStatus' | 'agentStatus' | 'agentStatusDetail'> {
    return {
      activityStatus: published.activityStatus,
      agentStatus: published.reading?.status ?? null,
      agentStatusDetail: published.reading?.detail ?? null,
    }
  }

  async function recentActionsForAgent(agentUserId: string): Promise<{ actions: string[]; lastActionAt: string | null } | null> {
    return await options.runtimeBridge?.recentActionsForAgent?.(agentUserId) ?? null
  }

  function recentActionsKey(snapshot: { actions: string[]; lastActionAt: string | null } | null): string {
    return snapshot ? JSON.stringify([snapshot.actions, snapshot.lastActionAt]) : ''
  }

  async function publishLocalAgentActivity(generation: number): Promise<void> {
    try {
      const localAgents = agentsForOwner(await listAgents(env), activeOwnerUserId)
      const agentUserIds: string[] = []
      for (const agent of localAgents) {
        if (!agent.gugu_user_id) continue
        if (agent.agent_type === CLOUD_AGENT_TYPE) continue
        // 候选口径必须与 markLocalRuntimeAgentsOnline 一致,#5331 这条跳过也一样。
        if (agentCloudIdentityPending(agent)) continue
        agentUserIds.push(agent.gugu_user_id)
      }
      const recentSnapshots = new Map<string, { actions: string[]; lastActionAt: string | null } | null>(
        await Promise.all(agentUserIds.map(async (id) => [id, await recentActionsForAgent(id)] as const)),
      )
      // 这条路每 2 秒走一轮,而它真正要写的时刻一次回合只有两个。所以**先判有没有变化,
      // 再决定要不要造客户端** —— 无条件 makeIdentityClient 会在空闲期每 2 秒造一个,
      // 纯浪费(而且它正好落在 owner 抱怨资源负载的那条路上)。
      // #4008 鉴权也在这道闸之后才取:没有要写的东西就不该去碰鉴权,否则空闲期每 2 秒问一次令牌。
      const somethingChanged = agentUserIds.some(
        (id) => !samePublishedStatus(publishedActivity.get(id), publishedStatusOf(agentStatusOf(id))),
      ) || agentUserIds.some(
        (id) => publishedRecentActions.get(id) !== recentActionsKey(recentSnapshots.get(id) ?? null),
      ) || [...publishedActivity.keys()].some((id) => !agentUserIds.includes(id))
      if (!somethingChanged) return
      const auth = await options.authProvider.getAuth()
      if (!auth?.accessToken || !auth.userId) return
      if (generation !== lifecycleGeneration || stopped) return
      if (activeOwnerUserId !== auth.userId) return
      const client = options.makeIdentityClient(auth.accessToken)
      const reportRuntimeState = makeRuntimeStateReporter(client)
      await publishAgentStatusTransitions({
        agentUserIds,
        published: publishedActivity,
        statusOf: agentStatusOf,
        report: async (agentUserId, published) => {
          const recent = recentSnapshots.get(agentUserId) ?? null
          await reportRuntimeState({
            agentUserId,
            runtimeStatus: 'online',
            ...presenceFields(published),
            runtimeKind: 'gugu',
            runtimeLabel: hostname(),
            recentActions: recent?.actions ?? null,
            lastActionAt: recent?.lastActionAt ?? null
          })
          publishedRecentActions.set(agentUserId, recentActionsKey(recent))
        },
        shouldPublish: (agentUserId) =>
          publishedRecentActions.get(agentUserId) !== recentActionsKey(recentSnapshots.get(agentUserId) ?? null),
        shouldBail: () => generation !== lifecycleGeneration || stopped,
        warn: options.warn
      })
    } catch (error) {
      // @@@4395 auth 永久失效是**终态**,必须逃出这层 catch 交给外层的 @@@auth-expired-once 守卫。
      // 原先这里无差别吞掉:外层 publishAgentActivityOnce 的 handleAuthExpired 因此永远等不到它,
      // 一次性的「请重新登录」被 activityTimer(2s)变成无限刷屏 —— 用户侧表现为提示不断重复。
      if (error instanceof RuntimeAuthExpiredError) throw error
      options.warn?.(`[device-runtime] activity edge publish failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  async function stop(): Promise<void> {
    const runningTick = activeTick
    stopped = true
    lifecycleGeneration += 1
    activeTickAbortController?.abort(new Error('device runtime host stopped'))
    if (superviseTimer !== null) clearInterval(superviseTimer)
    superviseTimer = null
    clearDrainFollowUp()
    clearUnannouncedVerdict()
    clearScheduledTasksTimer()
    // 下一次 start() 是一个新的生命周期:第一次确立 owner 边界之后要重新排一次定时任务。
    scheduledTasksPlanned = false
    workFailureStreak = 0
    wakeSubscribeFailures = 0
    queueBelievedEmpty = false
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    if (activityTimer !== null) clearInterval(activityTimer)
    activityTimer = null
    unsubscribeAgentTurnState?.()
    unsubscribeAgentTurnState = null
    unsubscribeCommandWake()
    unsubscribeDeviceRpc()
    lastAuth = null
    if (runningTick) await runningTick.catch(() => undefined)
    // 定时任务那一轮从前是在 tick 里被 await 的;现在它有自己的 flight,停机同样要等它落地 ——
    // 否则它会在宿主已经拆掉之后继续拿着旧令牌写库(推进了排期却还没入队 = 丢一次运行)。
    if (activeScheduledTasksRun) await activeScheduledTasksRun.catch(() => undefined)
    if (activeLeaseRenewal) await activeLeaseRenewal
    if (activeActivityPublish) await activeActivityPublish.catch(() => undefined)
    // 停机**不**逐个把本机 agent 标 offline:读方看的在线 / 离线只来自设备行(build_agent_presence_payload 的
    // derived_status 不看 runtime_status,而那一写自己就把 last_seen 刷新成「刚见过」),设备行由租约清扫者在
    // 租约过期后翻成 offline(#5912)。逐个写只换来退出要等 N 个请求(owner 178 个 agent 时撞满 5 秒上限)。
  }

  function getDebugSnapshot(): DeviceRuntimeHostDebugSnapshot {
    return {
      status: stopped ? 'stopped' : ticking ? 'ticking' : superviseTimer ? 'running' : 'idle',
      started: superviseTimer !== null,
      ticking,
      hasAuth: lastAuth !== null,
      authExpired,
      commandWakeSubscribed: wakeSubscribed,
      queuedCommandWake: queuedCommandWake !== null,
      drainFollowUpArmed: drainFollowUpTimer !== null,
      lastDeviceId,
      lastTickAt,
      lastError
    }
  }

  // 没在长跑(还没 start / 已 stop)就没有可通知的对象:start() 自己会发首轮。
  function notifyWork(): void {
    if (superviseTimer === null) return
    scheduleWorkTick()
  }

  return {
    tickOnce: () => tickOnce('event'),
    notifyAuthChanged: notifyWork,
    notifyCommandsChanged: () => {
      noteCommandAnnouncement()
      notifyWork()
    },
    notifyDeviceActionsChanged,
    start,
    stop,
    getDebugSnapshot,
  }
}
