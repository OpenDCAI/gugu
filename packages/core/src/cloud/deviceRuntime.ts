import type { DeviceActionsCapability } from '../shared/deviceActions'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from '../local/childProcess'
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { atomicWriteText, stateDir } from '../local/state/paths'
import type { AgentStatusView } from '../shared/agentStatus'
import { coreLogger } from '../log'
import {
  handleAgentCreateDeviceCommand,
  handleAgentDeliverDeviceCommand,
  handleAgentRetireDeviceCommand,
  handleAgentStopDeviceCommand,
  handleAgentSetModelDeviceCommand,
  createDeviceCommandHoldingResolver,
  isDisclosedUndeliverableAgentCommand,
  resolveGuguIds,
  type AgentRuntimeBridgeOptions
} from '../local/agent/deviceCommandRuntime'

const log = coreLogger('device-runtime')
import type { DeviceCommandHandlers } from './deviceCommands'
import {
  createNodeCommandRunner,
  type CommandRunner,
  type CommandRunResult,
} from '../local/terminal/commandRunner'
import { fetchThreadMessagesViaRest } from './threadMessagesRest'
import { recordAgentDeliverOutcome, type AgentDeliverOutcomeInput } from '../local/agent/agentDeliverOutcome'
import { isSaidInChat } from '../local/agent/agentInboxReader'
import {
  deferDeviceCommand,
  processPendingDeviceCommandsOnce,
  recoverOrphanedDeviceCommands,
  reportRuntimeInstanceHeartbeat,
  deviceCommandAgentUserId,
  type DeviceCommandTableClient,
  type ProcessDeviceCommandResult,
} from './deviceCommands'
import { dbPayload } from './supabase'
import { resolveDeviceHostInfo } from './deviceHostInfo'
import { machineDisplayName } from '../device/machineDisplayName'
import type { DeviceHostInfo } from '../shared/types/deviceHost'
import {
  DeviceOperationTimeoutError,
  resolveDeviceOperationTimeouts,
  runDeviceOperation,
  runDeviceRequest,
  type DeviceOperationTimeoutOverrides,
} from './deviceOperationTimeouts'

export interface DeviceCapabilities {
  terminals: string[]
  runtimes: string[]
  // @@@host-runtime-capability (#647) - monotonic level of the host's gugu runtime. Bumped when a host
  host_runtime_capability?: number
  // @@@fleet-version (#663) - build version of the reporting app; kept in sync with the reader-side
  // DeviceCapabilities in shared/types/chat.ts (same two-sided convention as #647).
  app_version?: string
  published_desktop_version?: string
}

// @@@host-runtime-capability-value (#647) - bump when a critical host capability lands, then raise the DB
export const HOST_RUNTIME_CAPABILITY = 1

type DeviceHeartbeatResult = {
  error: { message: string } | null
  data?: { runtimes: string[] | null }[] | null
}

export interface DeviceHeartbeatTableClient {
  from(table: 'gugu_devices'): {
    upsert(value: never, options: { onConflict: string }): PromiseLike<DeviceHeartbeatResult>
    update(value: { status: 'online' | 'offline'; updated_at: string }): {
      eq(column: 'device_id', value: string): PromiseLike<DeviceHeartbeatResult> & {
        select(columns: 'runtimes:capabilities->runtimes'): PromiseLike<DeviceHeartbeatResult>
      }
    }
    select(columns: string): {
      eq(column: 'user_id', value: string): {
        eq(column: 'machine_id', value: string): {
          eq(column: 'tier', value: string): {
            limit(n: number): {
              maybeSingle(): PromiseLike<{ data: { device_id: unknown } | null; error: { message: string } | null }>
            }
          }
        }
      }
    }
  }
  rpc(
    fn: 'cleanup_legacy_gugu_devices',
    args: { p_keep_device_id: string; p_hostname: string }
  ): PromiseLike<DeviceHeartbeatResult>
}

export interface DeviceCapabilityProbe {
  // Test-only runners must honor the provided signal and terminal-settle the run after abort.
  runner?: CommandRunner
  platform?: () => string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  commandExists?: (command: string, signal?: AbortSignal) => Promise<boolean> | boolean
  commandSucceeds?: (args: readonly string[], signal?: AbortSignal) => Promise<boolean> | boolean
  pathExists?: (path: string, signal?: AbortSignal) => Promise<boolean> | boolean
}

export interface DeviceCapabilitiesSourceContext {
  signal: AbortSignal
}

export type DeviceCapabilitiesSource =
  | DeviceCapabilities
  | ((context: DeviceCapabilitiesSourceContext) => Promise<DeviceCapabilities> | DeviceCapabilities)

export interface DeviceOperationContext {
  signal: AbortSignal
}

export type DeviceMachineIdentifier = (
  context: DeviceOperationContext,
) => Promise<string> | string

export type DeviceIdCacheWriter = (
  path: string,
  deviceId: string,
  context: DeviceOperationContext,
) => Promise<void>

/**
 * 一台机器上会话的**状态摘要** —— 随心跳写进 `gugu_devices.session_digest`。
 *
 * 只为一件事存在：机器离线时手机仍要看得到「这台机器上有哪些会话、它们卡在哪儿」
 * （product spec 的验收）。会话页的会话是纯本地的，云端此前没有任何索引。
 *
 * ❌ 不放正文：会话名与状态是元信息，时间线内容与消息正文一概不进这里 ——
 * 「内容不在手机落库」那条边界没有放开。
 */
export type DeviceSessionDigestEntry = {
  nativeInputVersion?: 1 | 2
  runtime?: 'acp' | 'pty' | 'unknown'
  conversationId: string
  projectId: string
  projectName: string
  title: string
  harness: string
  /** 老版本手机读的旧词(见 `SessionpageSessionSummary.agentStatus`)。 */
  agentStatus: string | null
  /** 读数:基础态 + 附属态(spec agent-status-vocabulary)。`null` = 没有状态源。 */
  status?: AgentStatusView | null
  lastInteractedAt: string | null
  supported: boolean
  /**
   * 置顶 / 未读 / 父会话（#5013，2026-09-06 加）。这三项也是**元信息**，不越「不放正文」那条线。
   * 少了它们，离线时的会话列表会把置顶画成没置顶、未读画成已读、子 agent 画成平级。
   * ⚠️ 可选：读侧（`normalizeSessionDigest`）要能接住**老宿主写的、没有这几个键**的旧摘要。
   */
  isPinned?: boolean
  unseen?: boolean
  parentConversationId?: string | null
  /** 这条会话的 agent id(#7199,见 `DeviceSessionSummary.agentUserId`);宿主还没读到花名册时不带。 */
  agentUserId?: string | null
}

/** 摘要由宿主提供（会话在它手里）。缺省 = 这台机器不报摘要，列写 `[]`。 */
export type DeviceSessionDigestSource = () => DeviceSessionDigestEntry[]
/** #7199 这台设备能被调用的动作清单(`capabilities.actions`);缺省 = 不登记(老设备 / 不支持)。 */
export type DeviceActionsSource = () => DeviceActionsCapability | null

/** 一行写不下整台机器的历史：只带最近动过的这么多条。 */
export const DEVICE_SESSION_DIGEST_LIMIT = 50

export interface DeviceHeartbeatOptions {
  userId: string
  deviceId?: string
  nowIso?: () => string
  capabilities?: DeviceCapabilitiesSource
  capabilityTimeoutMs?: number
  sessionDigest?: DeviceSessionDigestSource
  deviceActions?: DeviceActionsSource
  label?: () => string
  hostname?: () => string
  platform?: () => string
  /** #6264 心跳随行报的「这是台什么机器」;缺省读本机(resolveDeviceHostInfo)。测试注入用。 */
  hostInfo?: (env: NodeJS.ProcessEnv) => DeviceHostInfo
  machineIdentifier?: DeviceMachineIdentifier
  deviceIdCacheWriter?: DeviceIdCacheWriter
  operationTimeouts?: DeviceOperationTimeoutOverrides
}

export interface DeviceRuntimeTickInput extends AgentRuntimeBridgeOptions {
  signal?: AbortSignal
  userId: string
  accessToken?: string
  refreshToken?: string | null
  commandClient: DeviceCommandTableClient
  // 认领之后落终态时现取的 client(带写那一刻有效的令牌);缺省沿用 commandClient。见 ProcessDeviceCommandOptions.resolveSettleClient。
  resolveSettleClient?: () => Promise<DeviceCommandTableClient>
  heartbeatClient: DeviceHeartbeatTableClient
  deviceId?: string
  nowIso?: () => string
  capabilities?: DeviceCapabilitiesSource
  capabilityTimeoutMs?: number
  sessionDigest?: DeviceSessionDigestSource
  deviceActions?: DeviceActionsSource
  label?: () => string
  syncHeartbeat?: boolean
  machineIdentifier?: DeviceMachineIdentifier
  deviceIdCacheWriter?: DeviceIdCacheWriter
  operationTimeouts?: DeviceOperationTimeoutOverrides
  recoverOrphanedCommands?: boolean
  /** 认领命令之前每一段结束时报一声(宿主拿它给慢的那一段计时);最后一声是 'claim'。 */
  onPhase?: (phase: string) => void
  onHeartbeatError?: (error: unknown) => void
  // @@@1676 — 本 runtime 进程的实例 id(每进程启动生成一次,host loop 注入)。命令认领写进 claimed_by,
  // 每 tick 刷新实例心跳;orphan 恢复据此区分「活兄弟在途」与「死实例孤儿」。缺省=单实例 legacy 语义。
  instanceId?: string
  // @@@5912 独立续租刚跑过时跳过 tick 自己那一次。宿主按「上一次独立续租距今不到一个续租周期」判定,
  // 那时租约至少还剩 60 s(TTL 90 s、续租周期 30 s)⇒「认领之前实例心跳必新鲜」这条不变量照旧成立。
  // ❌ 缺省不跳:老调用方与测试没有独立续租这条腿,它们的 tick 必须自己续。
  skipInstanceLeaseRenewal?: boolean
  // #2115 — agent.deliver 命令落终态 error(held 不算)时上抛给宿主:普通 ACP 回合失败以前只落库、
  // renderer 零观察 → 用户看不到任何失败提示。宿主(electron main)据此发 {type:'error'} 流事件。
  onAgentDeliverFailure?: (failure: AgentDeliverFailure) => void
  // @@@2175 — deliver 回合结局记录(连续异常计数,状态灯异常态数据源)。缺省 = 真 RPC
  // recordAgentDeliverOutcome;测试注入 spy。best-effort:记录失败仅告警,不影响命令流转。
  // S2b:喂灯点从命令结果迁到读者注入结果(注入成功/批失败/must-reply 违约)。
  recordDeliverOutcome?: (outcome: AgentDeliverOutcomeInput) => Promise<unknown>
}

// #2115 — deliver 终态失败的最小路由信息(commandId 供 renderer「重试」CAS error→pending 重排原命令)。
export interface AgentDeliverFailure {
  commandId: string
  /** Original source message; retries of it must not inflate the visible message count. */
  messageId?: string | null
  agentUserId: string
  chatId: string
  threadRootId: string | null
  error: string
  /** Original provider/runtime error when `error` is the sanitized chat disclosure. */
  cause?: string
}

export interface DeviceRuntimeTickResult {
  deviceId: string
  heartbeat: 'synced' | 'skipped' | 'error'
  commands: ProcessDeviceCommandResult[]
  /** 这一轮孤儿恢复放回 pending 的行数(没跑恢复闸的那一轮为 0)。 */
  recoveredOrphans: number
}

// #3812 收口 —— 权威状态写口已搬到 ./agentRuntimeStateReporter(渲染层也要走这道门,而本文件依赖
// node:child_process / node:fs,渲染层 import 不进来)。这里保留 re-export,既有 import 路径不动。
export {
  createAgentRuntimeStateReporter,
  isAgentRuntimeStateGoneError,
  type AgentRuntimeStateReporterHooks,
  type AgentRuntimeStateRpcClient,
  type AgentRuntimeStateWrite,
} from './agentRuntimeStateReporter'

/**
 * 排空跟进的间隔:上一轮取到过命令、却没有一条落终态(全是 held / unheld 这类留在 pending 的行)时,
 * 隔这么久再复查一轮。❌ 它不是轮询周期 —— 队列取空之后,宿主只在事件到来或对账节拍上才再取命令。
 * 合同见 spec device-runtime。
 */
export const DEVICE_COMMAND_DRAIN_RETRY_INTERVAL_MS = 2_000
/**
 * 对账节拍:事件之外**唯一**周期性的一轮 tick。它做天然周期的事(孤儿恢复闸、activity 对账闸、订阅自检与重订),
 * 并且取一次命令 —— 事件是提示,pending 队列才是真值:`realtime.send` 把自己的失败吞成 WARNING(INSERT 成功、
 * 广播静默丢失),而把行放回 pending 的几条 UPDATE(失败条的重试、别处的孤儿恢复)根本不发广播。
 * 对账取到「没有任何事件通知过」的行时宿主响亮告警,所以它同时是丢失率的仪器,❌ 不是一个安静的兜底。
 */
export const DEVICE_SUPERVISE_INTERVAL_MS = 30_000
export const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000
export const DEVICE_CAPABILITY_TIMEOUT_MS = 10_000

export class DeviceCapabilityTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`device capability detection timed out after ${timeoutMs}ms`)
    this.name = 'DeviceCapabilityTimeoutError'
  }
}

type CapabilityProbe =
  | { name: string; target: string; kind: 'which' | 'exists' }
  | { name: string; args: readonly string[]; kind: 'run' }

const TERMINAL_PROBES: readonly CapabilityProbe[] = [
  { name: 'tmux', target: 'tmux', kind: 'which' },
  { name: 'cmux', target: 'cmux', kind: 'which' },
  { name: 'kitty', target: 'kitty', kind: 'which' },
  { name: 'ghostty', target: 'ghostty', kind: 'which' },
  { name: 'ghostty', target: '/Applications/Ghostty.app', kind: 'exists' },
  { name: 'wezterm', args: ['wezterm', 'cli', '--prefer-mux', 'list', '--format', 'json'], kind: 'run' },
  { name: 'iterm2', target: '/Applications/iTerm.app', kind: 'exists' },
  { name: 'terminal', target: '/System/Applications/Utilities/Terminal.app', kind: 'exists' }
] as const

const RUNTIME_PROBES: readonly CapabilityProbe[] = [
  { name: 'claude-code', target: 'claude', kind: 'which' },
  { name: 'codex', target: 'codex', kind: 'which' },
  { name: 'powershell', target: 'pwsh', kind: 'which' },
  { name: 'powershell', target: 'powershell', kind: 'which' }
] as const

// @@@owner-scoped-device-cache - the on-disk cache is a reflection of one logical runtime identity.
// Keep it isolated by authenticated owner and app tier so an account switch cannot observe the previous
// owner's device id, even before the next cloud heartbeat completes. The hash keeps user ids out of paths.
export function deviceFile(env: NodeJS.ProcessEnv = process.env, userId?: string): string {
  const owner = userId?.trim() ?? ''
  if (!owner) throw new Error('deviceFile requires a non-empty userId')
  const scope = createHash('sha256')
    .update(`gugu-device-cache-v1:${owner}:${resolveTier(env)}`)
    .digest('hex')
  return join(stateDir(env), 'devices', scope, 'device.json')
}

// @@@ device-identity-contract — see git history for full context.
const execFileP = promisify(execFile)

export interface ResolveLocalDeviceIdOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly userId: string
  readonly heartbeatClient: DeviceHeartbeatTableClient
  readonly machineIdentifier?: DeviceMachineIdentifier
  readonly deviceIdCacheWriter?: DeviceIdCacheWriter
  readonly operationTimeouts?: DeviceOperationTimeoutOverrides
}

export async function resolveLocalDeviceId(options: ResolveLocalDeviceIdOptions): Promise<string> {
  return (await resolveLocalDeviceIdentity(options)).deviceId
}

/**
 * 本机在**当前账号**下的设备 id,桌面主进程与网页版无头宿主同一份(#5323、#4277)。
 *
 * 设备行是「一个账号 × 一台机器」一行、解析出来不会在一次身份期内改口 ⇒ 进程内**按 owner** 记一次:
 * 换号 ⇒ key 不命中 ⇒ 重解析,❌ 读到上一个 owner 的。所以 ❌ 先等设备运行时一轮 tick 再读它的缓存 ——
 * 那一步原本防的就是「换号后读到上一个 owner 的缓存」,按 owner 记忆以后它只剩 #4181 / #4320② 那两个等待环。
 *
 * 第一次解析出来先登记一次心跳再交出去:create_owned_agent、会话页身份供给拿它当参数,云端得先有这一行。
 * 同一 owner 并发的第一次合成一发。解析不出(没登录、网络)⇒ null,调用方响亮失败;下一次重来。
 */
export function createLocalDeviceIdResolver(options: {
  getAuth: () => Promise<{ accessToken?: string | null; userId?: string | null } | null>
  heartbeatClient: (accessToken: string) => DeviceHeartbeatTableClient
  capabilities: () => Promise<DeviceCapabilities>
  sessionDigest?: DeviceSessionDigestSource
  deviceActions?: DeviceActionsSource
  label?: () => string
  env?: NodeJS.ProcessEnv
  warn: (message: string) => void
}): () => Promise<string | null> {
  const env = options.env ?? process.env
  const byOwner = new Map<string, Promise<string>>()
  return async () => {
    try {
      const auth = await options.getAuth()
      if (!auth?.accessToken || !auth.userId) return null
      const userId = auth.userId
      let resolving = byOwner.get(userId)
      if (!resolving) {
        const heartbeatClient = options.heartbeatClient(auth.accessToken)
        resolving = (async () => {
          const deviceId = await resolveLocalDeviceId({ userId, heartbeatClient, env })
          // @@@5912 心跳不再顺手做 legacy 行清理(清理归宿主的周期闸),这里是一次性的登记写。
          await syncDeviceHeartbeat(heartbeatClient, {
            userId, deviceId, capabilities: options.capabilities,
            ...(options.sessionDigest ? { sessionDigest: options.sessionDigest } : {}),
            ...(options.deviceActions ? { deviceActions: options.deviceActions } : {}),
            ...(options.label ? { label: options.label } : {}),
          }, env)
          return deviceId
        })()
        byOwner.set(userId, resolving)
        resolving.catch(() => { if (byOwner.get(userId) === resolving) byOwner.delete(userId) })
      }
      return await resolving
    } catch (error) {
      options.warn(`device id resolve failed: ${(error as Error)?.message ?? String(error)}`)
      return null
    }
  }
}

async function resolveLocalDeviceIdentity(
  options: ResolveLocalDeviceIdOptions
): Promise<{ deviceId: string; machineId: string }> {
  if (!options.userId) {
    throw new Error('resolveLocalDeviceIdentity requires userId — there is no pre-login device id')
  }
  if (!options.heartbeatClient) {
    throw new Error('resolveLocalDeviceIdentity requires heartbeatClient — cloud is the source of truth')
  }
  const env = options.env ?? process.env
  const timeouts = resolveDeviceOperationTimeouts(options.operationTimeouts)
  const machineId = await runDeviceOperation(
    'device machine identifier',
    timeouts.machineIdentifierMs,
    (signal) => resolveMachineIdentifier(options.machineIdentifier, signal, env),
  )
  const tier = resolveTier(env)
  const inherited = await findExistingDeviceIdForUserMachine(
    options.heartbeatClient,
    options.userId,
    machineId,
    tier,
    timeouts.deviceLookupMs,
  )
  const deviceId = inherited ?? deterministicDeviceId(machineId, options.userId, tier)
  const cacheWriter = options.deviceIdCacheWriter ?? writeDeviceIdCache
  await runDeviceOperation(
    'device id cache write',
    timeouts.deviceCacheWriteMs,
    (signal) => cacheWriter(deviceFile(env, options.userId), deviceId, { signal }),
  )
  return { deviceId, machineId }
}

async function findExistingDeviceIdForUserMachine(
  client: DeviceHeartbeatTableClient,
  userId: string,
  machineId: string,
  tier: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runDeviceRequest(
    'device identity lookup',
    timeoutMs,
    () => client
      .from('gugu_devices')
      .select('device_id')
      .eq('user_id', userId)
      .eq('machine_id', machineId)
      .eq('tier', tier)
      .limit(1)
      .maybeSingle(),
  )
  if (result.error) throw new Error(result.error.message)
  const id = result.data?.device_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

// @@@tier-env (#523) - mirrors GUGU_HOME / RPC-port / tmux-socket tier scoping: electron sets GUGU_TIER
// from its build-time __GUGU_TIER__ (default 'production'); CLI/host launches leave it unset → production.
export function resolveTier(env: NodeJS.ProcessEnv = process.env): string {
  const tier = env.GUGU_TIER?.trim().toLowerCase()
  return tier && tier !== 'production' ? tier : 'production'
}

// @@@fleet-version (#663) - mirrors the GUGU_TIER pattern: electron main sets GUGU_APP_VERSION from
// app.getVersion() at startup; absent (tests / harnesses that never set it) → heartbeat omits the
// field rather than inventing a version.
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const version = env.GUGU_APP_VERSION?.trim()
  return version || undefined
}

async function resolveMachineIdentifier(
  override: DeviceMachineIdentifier | undefined,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (override) {
    const value = await override({ signal })
    if (value) return value
    throw new Error('Machine identifier override returned an empty value')
  }
  if (env.GUGU_SERVER_MODE === '1') return serverInstallationId(env, signal)
  return cachedMachineHardwareIdentifier(signal)
}

// @@@server-install-machine-id (#6264) - 咕咕 server 的「机器」= 这一次安装,❌ 不是 /etc/machine-id。
// 桌面按硬件标识认机器没问题:一台电脑一份。server 不行 —— 同一个镜像起的容器、克隆出来的虚拟机
// /etc/machine-id 一模一样(实测三个容器全落到同一个设备 id、在云端并成一行),同一台 Linux 上
// 桌面 + server 登同一个账号也会撞成一行((user, machine_id, tier) 唯一,server 会「继承」桌面那行)。
// 所以 server 在自己的安装目录(GUGU_SERVER_HOME,不是某个账号的目录)里首跑时发一个随机 id:
//   · 同一次安装的所有账号共用它 —— 设备 id 仍按账号各不相同(哈希里有 userId);
//   · 重启、升级(只换 versions/ 与 current)都不动它 ⇒ 设备 id 不变;
//   · 卸载会删掉整个安装目录 ⇒ 重装算一台新机器(旧行 30 天无心跳后由 stale 回收清掉)。
// 桌面(含 Linux 桌面)照旧走硬件标识,已有设备 id 一个字节都不变(见 @@@tier-isolated-device-id)。
export const SERVER_INSTALL_ID_FILE = 'install-id'

/**
 * 咕咕 server 这一次安装的机器标识(与它设备行上的 machine_id 同一个)。登录前就拿得到:
 * `gugu-server login` 把它报给云端,机器上限(#6264)按它认「是不是一台新机器」。
 */
export function resolveServerMachineId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return serverInstallationId(env, new AbortController().signal)
}
const serverInstallIds = new Map<string, Promise<string>>()
function serverInstallationId(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const home = env.GUGU_SERVER_HOME?.trim()
  if (!home) throw new Error('GUGU_SERVER_MODE=1 but GUGU_SERVER_HOME is not set (the server entry sets both)')
  const file = join(home, SERVER_INSTALL_ID_FILE)
  const cached = serverInstallIds.get(file)
  if (cached) return cached
  const flight = readOrCreateRandomId(file, signal)
  serverInstallIds.set(file, flight)
  void flight.catch(() => {
    if (serverInstallIds.get(file) === flight) serverInstallIds.delete(file)
  })
  return flight
}

// @@@ioreg-once - The hardware UUID does not change while a process is alive;
// caching avoids forking ioreg/reg/readFile on every 2s runtime tick.
let cachedMachineId: Promise<string> | null = null
function cachedMachineHardwareIdentifier(signal: AbortSignal): Promise<string> {
  if (cachedMachineId) return cachedMachineId
  const flight = machineHardwareIdentifier(signal)
  cachedMachineId = flight
  void flight.catch(() => {
    if (cachedMachineId === flight) cachedMachineId = null
  })
  return flight
}

// Docker 容器、部分精简发行版既没有 /etc/machine-id 也没有 dbus 那份(#6264:在干净 Ubuntu 容器里
// 设备永远注册不上,每次心跳都 ENOENT)。那就自己发一个:首次随机生成,落在咕咕状态目录里,之后一直用它。
// 这条只管桌面;咕咕 server 根本不读硬件标识(见 @@@server-install-machine-id)。
// 独占发布(link):两个进程同时首跑时只有一个写成,另一个读它写下的值,不会一台机器两个身份。
async function persistedFallbackMachineId(signal: AbortSignal): Promise<string> {
  return readOrCreateRandomId(join(stateDir(process.env), 'machine-id'), signal)
}

/**
 * 读一个落盘的随机 id;还没有就发一个 —— 并发首跑只有一个写成,其余读它写下的值。
 * 先把整份写进本进程自己的临时文件,再 link 到正式路径:link 是独占的,正式路径上要么是写完的整份、要么还没有。
 * ❌ 直接 writeFile(flag 'wx'):它先建出空文件再写,抢输的一方 EEXIST 后去读,正好读到那个空文件。
 */
async function readOrCreateRandomId(file: string, signal: AbortSignal): Promise<string> {
  try {
    const id = (await readFile(file, { encoding: 'utf8', signal })).trim()
    if (id) return id
    // 空文件 = 改前那种「先建文件再写」被打断留下的(用户机器上可能真有):当作没有,拿掉再走新建。
    await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(staged, `${randomUUID().replace(/-/g, '')}\n`, { mode: 0o644 })
  try {
    await link(staged, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await unlink(staged)
  }
  const id = (await readFile(file, { encoding: 'utf8', signal })).trim()
  if (!id) throw new Error(`persisted machine id file is empty: ${file}`)
  return id
}

/** 取硬件标识要碰的系统面;测试注入假的,按平台验解析。 */
export interface MachineIdIo {
  platform: NodeJS.Platform
  exec: (file: string, args: string[], signal: AbortSignal) => Promise<string>
  readText: (path: string, signal: AbortSignal) => Promise<string>
  fallback: (signal: AbortSignal) => Promise<string>
}
const systemMachineIdIo: MachineIdIo = {
  get platform() { return platform() },
  exec: async (file, args, signal) => (await execFileP(file, args, { signal })).stdout,
  readText: (path, signal) => readFile(path, { encoding: 'utf8', signal }),
  fallback: persistedFallbackMachineId,
}

/** 本机硬件标识(macOS IOPlatformUUID / Windows MachineGuid / Linux machine-id),进程内只取一次。 */
export function resolveMachineHardwareId(): Promise<string> {
  return cachedMachineHardwareIdentifier(new AbortController().signal)
}

export async function machineHardwareIdentifier(signal: AbortSignal, io: MachineIdIo = systemMachineIdIo): Promise<string> {
  if (io.platform === 'darwin') {
    const stdout = await io.exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], signal)
    const m = stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)
    if (m) return m[1]
    throw new Error('IOPlatformUUID not found')
  }
  if (io.platform === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = (await io.readText(path, signal)).trim()
        if (id) return id
      } catch { /* fall through */ }
    }
    return io.fallback(signal)
  }
  if (io.platform === 'win32') {
    const stdout = await io.exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], signal)
    const m = stdout.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)
    if (m) return m[1]
    throw new Error('MachineGuid not found')
  }
  throw new Error(`unsupported platform ${io.platform}`)
}

// @@@tier-isolated-device-id (#523) - the production tier MUST keep the legacy hash
// (`gugu-device-v1:machine:user`) byte-for-byte so the entire existing fleet keeps its device_id; only
// non-production tiers fold the tier into the hash, giving beta/etc. a distinct id on the same machine.
// Two tiers on one machine then register as separate devices and stop competing for device commands.
export function deterministicDeviceId(machineId: string, userId: string, tier = 'production'): string {
  const material = tier && tier !== 'production'
    ? `gugu-device-v1:${machineId}:${userId}:${tier}`
    : `gugu-device-v1:${machineId}:${userId}`
  const hash = createHash('sha256').update(material).digest('hex')
  // Format as UUID v4-ish so it remains compatible with any caller that assumes UUID-shaped device_ids.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-')
}

// @@@cache-overwrites - device.json is a reflection of resolveLocalDeviceIdentity's result;
export async function writeDeviceIdCache(
  path: string,
  deviceId: string,
  context?: DeviceOperationContext,
): Promise<void> {
  context?.signal.throwIfAborted()
  await mkdir(dirname(path), { recursive: true })
  context?.signal.throwIfAborted()
  // @@@3890⑮ 原子替换，不是就地覆盖。裸 writeFile 先 O_TRUNC 再写：进程被硬杀就留下一个半截
  // device.json，而读侧 readLocalDeviceId 只把 ENOENT 当「没有」，JSON 坏掉是**直接抛** ——
  // 每个 CLI 消费者从此拿不到 device id，且它自己不重算（要等渲染层下一次心跳把缓存重写才自愈）。
  // atomicWriteText 走 tmp+rename+chmod 0600，与这里原本的 0600 私有语义一致，半截态不再存在。
  await atomicWriteText(path, JSON.stringify({ device_id: deviceId }, null, 2))
  context?.signal.throwIfAborted()
}

// @@@cache-read-only - For consumers that can't run resolveLocalDeviceIdentity themselves
export async function readCachedDeviceId(
  env: NodeJS.ProcessEnv = process.env,
  userId?: string,
): Promise<string> {
  const path = deviceFile(env, userId)
  const cached = await readLocalDeviceId(path)
  if (cached) return cached
  throw new Error(
    `device.json missing at ${path}; the device must be registered through the renderer's heartbeat tick before any CLI consumer can read it.`
  )
}

async function readLocalDeviceId(path: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as { device_id?: unknown }
    return typeof data.device_id === 'string' && data.device_id.length > 0 ? data.device_id : null
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

export async function detectDeviceCapabilities(
  probe: DeviceCapabilityProbe = {}
): Promise<DeviceCapabilities> {
  const timeoutMs = normalizeCapabilityTimeoutMs(probe.timeoutMs)
  const runner = probe.runner ?? createNodeCommandRunner()
  const activeCommandRuns = new Set<Promise<CommandRunResult>>()
  const trackedRunner: CommandRunner = {
    run: (args, options) => {
      const flight = runner.run(args, options)
      activeCommandRuns.add(flight)
      void flight.then(
        () => { activeCommandRuns.delete(flight) },
        () => { activeCommandRuns.delete(flight) },
      )
      return flight
    },
    checkOutput: (args) => runner.checkOutput(args),
    sleep: (seconds) => runner.sleep(seconds),
  }
  try {
    return await withCapabilityTimeout(timeoutMs, async (signal) => {
      return await detectDeviceCapabilitiesWithin(probe, signal, trackedRunner)
    })
  } catch (error) {
    if (error instanceof DeviceCapabilityTimeoutError) {
      await Promise.allSettled([...activeCommandRuns])
    }
    throw error
  }
}

async function detectDeviceCapabilitiesWithin(
  probe: DeviceCapabilityProbe,
  signal: AbortSignal,
  runner: CommandRunner,
): Promise<DeviceCapabilities> {
  const currentPlatform = probe.platform ?? platform
  const commandExists = probe.commandExists ?? defaultCommandExists(runner, currentPlatform)
  const commandSucceeds = probe.commandSucceeds ?? defaultCommandSucceeds(runner)
  const pathExists = probe.pathExists ?? defaultPathExists
  const bundledTmux = (probe.env ?? process.env).GUGU_TMUX_BIN?.trim()
  const terminalProbes: readonly CapabilityProbe[] = [
    ...(bundledTmux ? [{ name: 'tmux', target: bundledTmux, kind: 'exists' } satisfies CapabilityProbe] : []),
    ...(currentPlatform() === 'win32' ? [{ name: 'terminal', target: 'powershell', kind: 'which' } satisfies CapabilityProbe] : []),
    ...TERMINAL_PROBES,
  ]
  return {
    terminals: await collectCapabilities(terminalProbes, commandExists, commandSucceeds, pathExists, signal),
    runtimes: await collectCapabilities(RUNTIME_PROBES, commandExists, commandSucceeds, pathExists, signal),
    host_runtime_capability: HOST_RUNTIME_CAPABILITY
  }
}

function normalizeCapabilityTimeoutMs(timeoutMs: number | undefined): number {
  const normalized = timeoutMs ?? DEVICE_CAPABILITY_TIMEOUT_MS
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`device capability timeout must be a positive finite number, got ${normalized}`)
  }
  return normalized
}

async function withCapabilityTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController()
  const timeoutError = new DeviceCapabilityTimeoutError(timeoutMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError)
      controller.abort(timeoutError)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveDeviceCapabilities(
  source: DeviceCapabilitiesSource | undefined,
  timeoutMs: number | undefined,
): Promise<DeviceCapabilities> {
  const normalizedTimeoutMs = normalizeCapabilityTimeoutMs(timeoutMs)
  if (!source) return await detectDeviceCapabilities({ timeoutMs: normalizedTimeoutMs })
  if (typeof source !== 'function') return source
  return await withCapabilityTimeout(normalizedTimeoutMs, (signal) => source({ signal }))
}

/**
 * 摘要是**尽力而为**：取不到就写空数组。
 *
 * ❌ 不让它把心跳带崩：心跳是 presence 的唯一写者，为了一份「离线时好看一点」的附加信息
 * 让整台机器在别人眼里下线，是拿主要的换次要的。
 */
function resolveSessionDigest(source: DeviceSessionDigestSource | undefined): DeviceSessionDigestEntry[] {
  if (!source) return []
  try {
    return source().slice(0, DEVICE_SESSION_DIGEST_LIMIT)
  } catch {
    return []
  }
}

/** 动作清单同样尽力而为:取不到就不登记这一格,❌ 让心跳失败(那会让整台机器在别人眼里下线)。 */
function resolveDeviceActions(source: DeviceActionsSource | undefined): { actions?: DeviceActionsCapability } {
  if (!source) return {}
  try {
    const actions = source()
    return actions ? { actions } : {}
  } catch {
    return {}
  }
}

export async function syncDeviceHeartbeat(
  client: DeviceHeartbeatTableClient,
  options: DeviceHeartbeatOptions,
  env: NodeJS.ProcessEnv = process.env,
  publishedCapabilities?: Map<string, string>,
): Promise<void> {
  const now = (options.nowIso ?? nowIso)()
  const detectedCapabilities = await resolveDeviceCapabilities(
    options.capabilities,
    options.capabilityTimeoutMs,
  )
  // @@@fleet-version (#663) - fold the build version in at row-assembly so every capabilities source
  // (default probe or injected) reports it; heartbeat is the single writer of gugu_devices rows.
  const appVersion = resolveAppVersion(env)
  const hostInfo = (options.hostInfo ?? resolveDeviceHostInfo)(env)
  // #6264 设置 → 设备每一行要写清是台什么机器(桌面/server、系统、架构、server 升级到哪了),同样在组行时折进来。
  const capabilities = {
    ...detectedCapabilities,
    ...(appVersion ? { app_version: appVersion } : {}),
    ...(appVersion && env.GUGU_BUILD_DISTRIBUTION === 'published' && hostInfo.host_kind === 'desktop'
      ? { published_desktop_version: appVersion } : {}),
    ...hostInfo,
    ...resolveDeviceActions(options.deviceActions),
  }
  const timeouts = resolveDeviceOperationTimeouts(options.operationTimeouts)
  const identity = options.deviceId
    ? {
        deviceId: options.deviceId,
        machineId: await runDeviceOperation(
          'device machine identifier',
          timeouts.machineIdentifierMs,
          (signal) => resolveMachineIdentifier(options.machineIdentifier, signal, env),
        ),
      }
    : await resolveLocalDeviceIdentity({
        env,
        userId: options.userId,
        heartbeatClient: client,
        machineIdentifier: options.machineIdentifier,
        deviceIdCacheWriter: options.deviceIdCacheWriter,
        operationTimeouts: options.operationTimeouts,
      })
  const deviceHostname = (options.hostname ?? hostname)()
  const tier = resolveTier(env)
  const registration = {
    device_id: identity.deviceId,
    user_id: options.userId,
    // 这台电脑的名字(❌ 主机名直接截:macOS 上它常常是 IP,见 device/machineDisplayName.ts)。
    label: options.label ? options.label() : machineDisplayName(),
    hostname: deviceHostname,
    machine_id: identity.machineId,
    platform: (options.platform ?? platform)(),
    tier,
    capabilities,
  }
  const presence = {
    status: 'online' as const,
    last_seen_at: now,
    updated_at: now,
    session_digest: resolveSessionDigest(options.sessionDigest)
  }
  const content = JSON.stringify(registration)
  const write = (register: boolean) => runDeviceRequest(
    'device heartbeat write', timeouts.heartbeatUpsertMs, () => register
      ? client.from('gugu_devices').upsert(dbPayload({ ...registration, ...presence }), { onConflict: 'device_id' })
      // A missing/cleared registration is restored through the same full upsert.
      : client.from('gugu_devices').update(presence).eq('device_id', identity.deviceId).select('runtimes:capabilities->runtimes'),
  )
  try {
    const register = publishedCapabilities?.get(identity.deviceId) !== content
    let result = await write(register)
    if (!result.error && !register && result.data?.[0]?.runtimes == null) result = await write(true)
    if (result.error) throw new Error(result.error.message)
    publishedCapabilities?.set(identity.deviceId, content)
  } catch (error) {
    publishedCapabilities?.delete(identity.deviceId)
    throw error
  }
}

/**
 * 这台机器要走了(退出咕咕 / 停掉服务):当场把设备行标成离线,名下别的设备马上看见 ——
 * ❌ 不说一声就走,让它们等租约过期(DEVICE_ONLINE_STALE_MS)由清扫者翻,那与崩溃看起来一模一样(#156)。
 * 只改状态:last_seen_at 是心跳的事,不动。下一次心跳照常写回在线。
 */
export async function markDeviceOffline(
  client: DeviceHeartbeatTableClient,
  deviceId: string,
  options: { nowIso?: () => string; operationTimeouts?: DeviceOperationTimeoutOverrides } = {},
): Promise<void> {
  const timeouts = resolveDeviceOperationTimeouts(options.operationTimeouts)
  const { error } = await runDeviceRequest(
    'device offline update',
    timeouts.heartbeatUpsertMs,
    () => client.from('gugu_devices').update({ status: 'offline', updated_at: (options.nowIso ?? nowIso)() }).eq('device_id', deviceId),
  )
  if (error) throw new Error(error.message)
}

// @@@5912 legacy 行清理**不是心跳的一部分** —— 它此前挂在每一拍上,每 30 秒一个请求,
// 而它要处理的事实(同 hostname 的老行、30 天没上线的行)在一次运行期内根本不会变。
// 宿主每个 owner 跑一次即可(见 deviceRuntimeHost 的 legacyCleanupDoneForOwner)。
// ⚠️ 它是 owner-scoped(函数体里 auth.uid()),所以「一次」的单位是**每个 owner**,不是每个进程。
export async function cleanupLegacyDeviceRows(
  client: DeviceHeartbeatTableClient,
  deviceId: string,
  options: { hostname?: () => string; operationTimeouts?: DeviceOperationTimeoutOverrides } = {},
): Promise<void> {
  const timeouts = resolveDeviceOperationTimeouts(options.operationTimeouts)
  const deviceHostname = (options.hostname ?? hostname)()
  const cleanup = await runDeviceRequest(
    'legacy device cleanup',
    timeouts.heartbeatCleanupMs,
    () => client.rpc('cleanup_legacy_gugu_devices', {
      p_keep_device_id: deviceId,
      p_hostname: deviceHostname,
    }),
  )
  if (cleanup.error) throw new Error(cleanup.error.message)
}

export async function runDeviceRuntimeTick(
  input: DeviceRuntimeTickInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<DeviceRuntimeTickResult> {
  const deviceId = input.deviceId ?? (await resolveLocalDeviceId({
    env,
    userId: input.userId,
    heartbeatClient: input.heartbeatClient,
    machineIdentifier: input.machineIdentifier,
    deviceIdCacheWriter: input.deviceIdCacheWriter,
    operationTimeouts: input.operationTimeouts,
  }))
  let heartbeat: DeviceRuntimeTickResult['heartbeat'] = 'skipped'
  if (input.syncHeartbeat !== false) {
    try {
      await syncDeviceHeartbeat(
        input.heartbeatClient,
        {
          userId: input.userId,
          deviceId,
          nowIso: input.nowIso,
          capabilities: input.capabilities,
          ...(input.sessionDigest ? { sessionDigest: input.sessionDigest } : {}),
          ...(input.deviceActions ? { deviceActions: input.deviceActions } : {}),
          ...(input.label ? { label: input.label } : {}),
          capabilityTimeoutMs: input.capabilityTimeoutMs,
          machineIdentifier: input.machineIdentifier,
          deviceIdCacheWriter: input.deviceIdCacheWriter,
          operationTimeouts: input.operationTimeouts,
        },
        env
      )
      heartbeat = 'synced'
    } catch (error) {
      if (error instanceof DeviceOperationTimeoutError) throw error
      heartbeat = 'error'
      input.onHeartbeatError?.(error)
    }
  }
  // @@@1676 — 实例心跳必须在 orphan 恢复 + 认领之前:保证认领命令时本实例心跳已新鲜,不被兄弟误回收。
  if (input.instanceId && !input.skipInstanceLeaseRenewal) {
    await reportRuntimeInstanceHeartbeat(
      input.commandClient,
      input.instanceId,
      deviceId,
      input.operationTimeouts,
    )
  }
  input.onPhase?.('lease')
  let recoveredOrphans = 0
  if (input.recoverOrphanedCommands) {
    recoveredOrphans = await recoverOrphanedDeviceCommands(input.commandClient, deviceId, input.operationTimeouts)
  }
  input.onPhase?.('orphans')
  // @@@2175 deliver 回合结局记录(连续异常计数)best-effort 收口:记录失败仅告警(fail-loud 可 grep),
  // 绝不影响命令流转——灯是派生信号,数据源写失败不能反过来弄失败回合本身。
  const recordDeliverOutcomeBestEffort = (outcome: AgentDeliverOutcomeInput): void => {
    const record = input.recordDeliverOutcome ?? ((o: AgentDeliverOutcomeInput) => recordAgentDeliverOutcome(o, { env }))
    // record 进 promise 链后再调:注入实现若同步 throw 也被 catch 兜住,不反噬命令流转。
    void Promise.resolve()
      .then(() => record(outcome))
      .catch((e: unknown) =>
        console.warn(`[device-runtime] #2175 deliver outcome record failed for ${outcome.agentUserId}:`, e)
      )
  }
  const commandHandlers: DeviceCommandHandlers = {
      'agent.create': (command, signal) =>
        handleAgentCreateDeviceCommand(
          command.payload ?? {},
          {
            ownerUserId: input.userId,
            deviceId,
            accessToken: input.accessToken,
            resolveGuguIds,
            runtimeBridge: input.runtimeBridge,
            signal,
            reportRuntimeState: input.reportRuntimeState,
            onRuntimeStateReportError: input.onRuntimeStateReportError,
            onAgentCreateStage: (stage) => {
              log.info({
                commandId: command.id,
                agentUserId: deviceCommandAgentUserId(command) || 'unknown',
                stage,
              }, 'agent.create stage')
            },
          },
          env,
        ),
      'agent.deliver': async (command, signal) => {
        if (!input.accessToken) {
          throw new Error('agent.deliver requires a fresh owner access token')
        }
        // @@@2175 喂灯点 = 读者注入结局(注入受理 ok / 批失败或违约 not-ok);skip/not-live 不记——
        // 没跑引擎的轮不构成计数证据,失败灯不能被一次静默 skip 无证据地清掉。
        const result = await handleAgentDeliverDeviceCommand(
          command.payload ?? {},
          {
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            runtimeBridge: input.runtimeBridge,
            ownerUserId: input.userId,
            signal,
            reportRuntimeState: input.reportRuntimeState,
            onRuntimeStateReportError: input.onRuntimeStateReportError,
            resolveGuguIds,
            // @@@1379 thread bootstrap — 首进 thread 隔离 session 时拉该 thread 历史作上下文 seed。
            fetchThreadMessages: (chatId, threadRootId) => fetchThreadMessagesViaRest(chatId, threadRootId, input.accessToken),
            commandCreatedAt: command.created_at,
            recordDeliverOutcome: (outcome) => recordDeliverOutcomeBestEffort(outcome),
          },
          env
        )
        if (result.delivered && result.completion) {
          const { completion, ...admissionResult } = result
          return deferDeviceCommand(admissionResult, completion.then(() => admissionResult))
        }
        return result
      },
      'agent.stop': (command) =>
        handleAgentStopDeviceCommand(
          command.payload ?? {},
          {
            runtimeBridge: input.runtimeBridge,
            reportRuntimeState: input.reportRuntimeState,
            onRuntimeStateReportError: input.onRuntimeStateReportError
          },
          env
        ),
      // #7199 个人助理搬去了别的设备:旧家拆运行时(不删文件)。
      'agent.retire': (command) =>
        handleAgentRetireDeviceCommand(command.payload ?? {}, { runtimeBridge: input.runtimeBridge }, env),
      // #5276 —— 云端 desired 已写好；这里把它落成本机事实，再把 applied / 原话回写云端。
      'agent.set_model': (command) =>
        handleAgentSetModelDeviceCommand(
          command.payload ?? {},
          {
            runtimeBridge: input.runtimeBridge,
            reportModelSelection: async (report) => {
              const { error } = await input.commandClient.rpc('report_agent_model_selection', {
                p_agent_user_id: report.agentUserId,
                p_applied: report.applied,
                p_error: report.error,
              })
              if (error) throw new Error(error.message)
            },
          },
          env
        ),
  }
  const holdingResolver = input.instanceId
    ? createDeviceCommandHoldingResolver({
        client: input.commandClient,
        deviceId,
        instanceId: input.instanceId,
        env,
        operationTimeouts: input.operationTimeouts,
        nowMs: () => Date.parse((input.nowIso ?? (() => new Date().toISOString()))()),
      })
    : undefined
  input.onPhase?.('claim')
  const commands = await processPendingDeviceCommandsOnce(
    input.commandClient,
    deviceId,
    commandHandlers,
    {
      nowIso: input.nowIso,
      instanceId: input.instanceId,
      createClaimToken: randomUUID,
      operationTimeouts: input.operationTimeouts,
      signal: input.signal,
      ...(input.resolveSettleClient ? { resolveSettleClient: input.resolveSettleClient } : {}),
      // #5041 — 同账号同机多实例共享 device_id:只 claim 本实例持有(名册)或没有任何活着的实例持有的 agent 的命令;活着的兄弟
      // 最近执行过的 agent 归它。没有 instanceId 的老调用方/测试没有「兄弟」概念,保持单实例语义(与 claimed_by legacy 同一条线)。
      ...(holdingResolver ? { resolveHolding: holdingResolver } : {}),
      // #2115 — 只把 agent.deliver 的终态失败上抛(其余命令类型的失败面各归各:create 有 agentCreationLifecycle
      // 观察,stop 无用户在等)。payload 字段缺失(畸形命令)无从路由到会话 → warn 后跳过,不吞不炸。
      onCommandFailed: (command, error, cause, failure) => {
        if (command.type !== 'agent.deliver') return
        const payload = (command.payload ?? {}) as Record<string, unknown>
        const agentUserId = deviceCommandAgentUserId(command)
        const chatId = typeof payload.chat_id === 'string' ? payload.chat_id : ''
        // #5041 — 无人持有的 agent:handler 已向来源 chat 落了用户可见的披露,这里不再叠通用失败条(它带 Retry,而 Retry 只会
        // 把同一条送回同一个「无人持有」),也不计入 #2175 的异常回合(agent 没在这台机器上跑,不是它的回合异常)。
        if (isDisclosedUndeliverableAgentCommand(failure)) {
          log.error(
            { commandId: command.id, agentUserId, chatId },
            'agent.deliver undeliverable: no live instance on this device holds the agent; disclosed in the source chat',
          )
          return
        }
        // @@@2175 终态失败 = 异常回合 +1(held 不进本回调,与「瞬时失败区分」天然对齐)。只需 agentUserId,
        // 先于下方路由字段检查——缺 chatId 只是发不了会话内提示,计数照记。
        if (agentUserId) {
          recordDeliverOutcomeBestEffort({ agentUserId, ok: false })
        }
        if (!agentUserId || !chatId) {
          console.warn(`[device-runtime] agent.deliver ${command.id} failed but payload lacks routing fields — no UI notice`)
          return
        }
        // 编号 17 — 这一批的失败已在来源 chat 落了 system 行(discloseBatchFailure):不再叠第二层失败条(#7125 同一次失败只说一次)。
        // 未读还在云端游标后,下一个触发自己重拉,Retry 没有可做的;而这条失败条在 agent 恢复以后也从来没人收。
        if (isSaidInChat(failure)) return
        const threadRootId = typeof payload.thread_root_id === 'string' && payload.thread_root_id ? payload.thread_root_id : null
        input.onAgentDeliverFailure?.({
          commandId: command.id,
          messageId: typeof payload.message_id === 'string' ? payload.message_id : null,
          agentUserId,
          chatId,
          threadRootId,
          error,
          ...(cause ? { cause } : {}),
        })
      },
    }
  )
  return { deviceId, heartbeat, commands, recoveredOrphans }
}

function defaultCommandExists(runner: CommandRunner, currentPlatform: () => string) {
  return async (command: string, signal?: AbortSignal): Promise<boolean> =>
    (await runner.run(
      [currentPlatform() === 'win32' ? 'where' : 'which', command],
      { signal },
    )).status === 0
}

function defaultCommandSucceeds(runner: CommandRunner) {
  return async (args: readonly string[], signal?: AbortSignal): Promise<boolean> =>
    (await runner.run([...args], { signal })).status === 0
}

async function defaultPathExists(path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    await access(path)
    signal?.throwIfAborted()
    return true
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

async function collectCapabilities(
  probes: readonly CapabilityProbe[],
  commandExists: (command: string, signal?: AbortSignal) => Promise<boolean> | boolean,
  commandSucceeds: (args: readonly string[], signal?: AbortSignal) => Promise<boolean> | boolean,
  pathExists: (path: string, signal?: AbortSignal) => Promise<boolean> | boolean,
  signal: AbortSignal,
): Promise<string[]> {
  const found: string[] = []
  for (const probe of probes) {
    signal.throwIfAborted()
    try {
      const ok =
        probe.kind === 'which'
          ? await commandExists(probe.target, signal)
          : probe.kind === 'run'
            ? await commandSucceeds(probe.args, signal)
            : await pathExists(probe.target, signal)
      if (ok && !found.includes(probe.name)) found.push(probe.name)
    } catch {
      signal.throwIfAborted()
      continue
    }
  }
  return found
}

function nowIso(): string {
  return new Date().toISOString()
}
