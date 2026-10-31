import { execFile } from '@gugu/core/local/childProcess'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentModelSelectionForProtocol,
  atomicWriteText,
  cachedAgentModelSelection,
  findLocalAgentByUserId,
  platformModelAccessEnv,
  MODEL_ACCESS_PROTOCOL_IDS,
  requireRuntimeAuth,
  RuntimeAuthError,
  RuntimeAuthUnavailableError,
  resolveGuguHome,
  type AgentModelSelection,
  type ModelAccessProtocol,
  type RuntimeAuth,
  type RuntimeAuthProvider,
} from '@gugu/core'
import { platformProtocolForEngine } from './engine-injection-contract'
import * as electron from 'electron'
import type { PlatformCallableRoutes } from '@gugu/session-core/agents/plugins'
import type { GuguCatalogReason } from '@gugu/session-core/session-record/contract'
import { createLogger } from './lib/logger'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { platformModelsEnabled } from '@gugu/core/cloud/optionalServices'
import { parsePlatformReasoningEfforts } from '../src/session/shared/core/agents/platform-model'

// Protocol membership is decided by the shared protocol table, so adding a
// protocol never means editing a literal union in this file.
function isModelAccessProtocol(value: unknown): value is ModelAccessProtocol {
  return typeof value === 'string'
    && (MODEL_ACCESS_PROTOCOL_IDS as string[]).includes(value)
}

export interface PlatformModelCatalogItem {
  id: string
  displayName: string
  protocols: ModelAccessProtocol[]
  enabled: boolean
  /**
   * 每条协议路由的积分倍率(New API ratio,基线 1.0 == $2/M),display-only。
   *
   * 按协议分开:同一个平台模型的两条网关别名各自定价。目录没给出某条协议的倍率就是「问不到」,
   * UI 省略数字但仍要标明按积分计费 —— ❌ 不得因缺倍率而隐藏模型或阻断会话。
   */
  creditMultipliers: Partial<Record<ModelAccessProtocol, number>>
  /**
   * @@@2503 C6 —— 该模型的总上下文窗口(token),权威值来自 billing.platform_models。
   *
   * null = 目录未标窗口(旧服务端不带此字段,或该行未填)。注入侧据此决定注不注入
   * CLAUDE_CODE_AUTO_COMPACT_WINDOW —— null 就不注入,让 harness 用默认。display 侧也可用它标注窗口。
   */
  contextWindow: number | null
  /**
   * 这个模型认的推理档(`billing.platform_models.reasoning_efforts`,#6447)。选档那一步与 harness 的清单
   * 取交集;null = 目录没有这条事实(旧服务端 / 还没从 models.dev 查过)⇒ 这个模型不画推理档。
   */
  reasoningEfforts: readonly string[] | null
  /** 这一档用不了、要开会员(目录 `requires_membership`,#7056)。旧服务端不带 ⇒ false。 */
  requiresMembership: boolean
  /** 他在设置「模型」页关掉了这一条 —— 不进他的模型下拉(目录 `hidden`,#7056)。旧服务端不带 ⇒ false。 */
  hidden: boolean
}

export interface IssuedModelAccess {
  accessSessionId: string
  relayUrl: string
  token: string
  model: string
  protocol: ModelAccessProtocol
  expiresAt: string
  /**
   * @@@2503 C6 —— 本次签发模型的总上下文窗口(token),签发时由服务端从 billing.platform_models 读出。
   * 注入进 `--settings` 的 env 块以压过用户自设的窗口值(见 modelAccess.ts inject)。null = 未知 → 不注入。
   */
  contextWindow: number | null
  /** 本次签发模型认的推理档(目录逐模型下发,#6447);null = 目录没有这条事实。 */
  reasoningEfforts: readonly string[] | null
  /**
   * 这枚会话令牌**还允许换到哪些模型** —— 这条协议下上架的全部平台模型(服务端 `switchableModelSet`)。
   * 永远包含 `model` 自己。会话票就是「这个用户的平台额度」这一件事,不是「这次选的那个模型」。
   *
   * ⚠️ 唯一真值在服务端:渠道分组只有网关知道,❌ 客户端不得自己从目录推导一份 —— 推出来的那份
   * 会比令牌宽,于是界面上选得中的模型每次调用都被网关拒,而症状离病根隔着一整层。
   *
   * 服务端没报这一项(旧版 edge function)时是空数组 = 「只有当前这一个能用」,
   * 注入侧因此退回单模型形态,行为与改动前逐字一致。
   */
  switchableModels: readonly {
    id: string
    displayName: string
    alias: string
    /** 这一条自己的上下文窗口;服务端没给(或非正整数)时为 null → 注入侧省略,让 harness 用自己的默认。 */
    contextWindow: number | null
    /** 这一条自己的推理档;同窗口一样各带各的(#6447)。 */
    reasoningEfforts: readonly string[] | null
  }[]
  /** Stable platform model id used to reissue an expired Claude lease. Older edge functions omit it. */
  modelId?: string
  /**
   * 这枚会话令牌在每条网关路由上能调哪些模型(#6921,服务端 gugu-supabase#95):键是网关路由原文
   * (`/v1/responses`、`/v1/images/generations`…),值是那条路由上能调的模型。
   *
   * 只给 harness 判断要不要打开它自己的内置工具(codex 出图打 `/v1/images/generations` 的 `gpt-image-2`),
   * ❌ 不进模型选择器 —— 选择器仍只认 `switchableModels`。
   * 老服务端不带这一项 ⇒ 空表 = 没有任何额外能力,行为与改动前逐字一致;❌ 不因缺席报错。
   */
  callableRoutes: PlatformCallableRoutes
  /**
   * 这一档走不到的网关别名(服务端 `membership_locked`,#7092)。指定了会员模型的免费档会话照常签到票、照常起,
   * 只是这几个不在票的白名单里:调它们那一轮网关回 403(说明由网关自己给);宿主据此让界面刷新目录。旧服务端不带 ⇒ 空。
   */
  membershipLocked: readonly string[]
}

function modelAccessFetch(url: string, init: RequestInit): Promise<Response> {
  const netFetch = (electron as { net?: { fetch?: typeof fetch } } | undefined)?.net?.fetch
  return netFetch ? netFetch(url, init) : fetch(url, init)
}

/**
 * model-access 的非 2xx 回应;status 让调用方分清「这张票服务端不认识」(404)与其它失败。
 * `reason` 是服务端给的机读定性(目前只有 `membership_required`,#7056);没给 = null。
 */
export class ModelAccessHttpError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string | null = null) {
    super(message)
    this.name = 'ModelAccessHttpError'
  }
}

export type ModelAccessFailureReason = Extract<
  GuguCatalogReason,
  'signed-out' | 'membership-required' | 'model-unavailable' | 'unreachable' | 'service-unavailable'
>

/** 服务端会让界面说话的那几个 `reason`(product spec「被拒时谁说话」);其余都不是说给人听的。 */
const SPOKEN_SERVER_REASONS: ReadonlyMap<string, ModelAccessFailureReason> = new Map<string, ModelAccessFailureReason>([
  ['signed_out', 'signed-out'],
  ['membership_required', 'membership-required'],
  ['model_unavailable', 'model-unavailable'],
])

/**
 * 一次 model-access 失败 → 界面按它说话的原因(session-core `GuguCatalogReason`,#7103「谁拒绝谁说话」)。
 * 服务端的 `reason` **只在这里**认,❌ 按 `error` 原文或状态码猜;表外的、不带 `reason` 的一律
 * `service-unavailable`(「咕咕这边出错了」),原文只进日志。
 * 唯一按状态码认的是 401:JWT 坏了 / 过期时函数前面的边缘运行时(`verify_jwt`)先拦,回的是它自己的 `{msg}`。
 * 本机这一侧:没登录、登录服务明说票不认 = 登录失效;登录服务连不上 / 5xx / 超时 = 咕咕这边出错了(规格:停库 ❌ 说成登录失效)。
 */
export function modelAccessFailureReason(error: unknown): ModelAccessFailureReason {
  if (error instanceof RuntimeAuthUnavailableError) return 'service-unavailable'
  if (error instanceof RuntimeAuthError) return 'signed-out'
  if (error instanceof ModelAccessUnreachableError) return 'unreachable'
  if (!(error instanceof ModelAccessHttpError)) return 'service-unavailable'
  if (error.status === 401) return 'signed-out'
  return SPOKEN_SERVER_REASONS.get(error.reason ?? '') ?? 'service-unavailable'
}

/** 请求根本没到 model-access(断网、DNS、TLS):与「到了但被拒」分开,界面要说的下一步不同。 */
export class ModelAccessUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`model access unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'ModelAccessUnreachableError'
  }
}

async function invokeModelAccess(
  authProvider: RuntimeAuthProvider,
  body: Record<string, unknown>,
  operation: string,
): Promise<Record<string, unknown>> {
  return invokeModelAccessAs(await requireRuntimeAuth(authProvider, operation), body)
}

async function invokeModelAccessAs(
  { accessToken }: RuntimeAuth,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!platformModelsEnabled()) throw new Error('Official model service is not configured')
  // #5331 签令牌走 Chromium 连接池(与 supabase-js 同池,空闲保活约 5 分钟);Node 全局 fetch 的 undici 池
  // 4 s 就断,两次新建会话之间必然冷掉,每次都重握 0.95 s 的 TLS。electron 缺席(单测)时退回全局 fetch。
  const response = await modelAccessFetch(`${getSupabaseUrl().replace(/\/$/, '')}/functions/v1/model-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  }).catch((error: unknown) => { throw new ModelAccessUnreachableError(error) })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new ModelAccessHttpError(
      typeof payload.error === 'string' ? payload.error : `model access HTTP ${response.status}`,
      response.status,
      typeof payload.reason === 'string' && payload.reason ? payload.reason : null,
    )
  }
  return payload
}

/**
 * #5276 一个 Agent 级模型选择能不能落到这个引擎上 —— 校验只有这一份（原先住在 IPC `agent-model:set` 里）。
 * 设备命令 `agent.set_model` 与任何别的入口都走它：目录里有、已上架、协议与引擎一致；不过就 throw 原话。
 * `default` / `byok` 不查目录：它们不花咕咕的钱，能不能跑由 harness 自己说。
 */
export async function assertAgentModelSelectionOpen(input: {
  authProvider: RuntimeAuthProvider | null
  engineId: string | null
  selection: AgentModelSelection
}): Promise<void> {
  if (input.selection.source !== 'platform') return
  if (!input.authProvider) throw new Error('Agent 运行时尚未连接')
  if (!input.engineId) throw new Error('这个 Agent 的引擎不支持咕咕提供的模型')
  // 协议**按引擎重新算**,❌ 不拿传进来的那份去比。传进来的可能是一条存下来的旧选择,而协议是
  // 派生值:#5824 改了几家 harness 的线协议之后,那一栏在所有旧记录里都是过期的,照旧比对会把
  // 一个完全正常的模型判成「尚未开放」。真正要问的是**这个模型在这个引擎的协议上有没有上架**。
  const selection = agentModelSelectionForProtocol(input.selection, platformProtocolForEngine(input.engineId))
  if (selection.source !== 'platform') return
  const models = await listPlatformModels(input.authProvider)
  const model = models.find((candidate) => candidate.id === selection.modelId)
  if (!model?.enabled || !model.protocols.includes(selection.protocol)) {
    throw new Error(`这个平台模型尚未对当前 Agent 开放（${selection.modelId} / ${selection.protocol}）`)
  }
  // 存成 Agent 默认也一样:免费档存一个会员模型,下一次开会话只会在签发那一步被拒(#7056)。
  if (model.requiresMembership) throw new Error(`咕咕 ${model.displayName} 要开会员才能用`)
}

export async function listPlatformModels(authProvider: RuntimeAuthProvider): Promise<PlatformModelCatalogItem[]> {
  if (!platformModelsEnabled()) return []
  const payload = await invokeModelAccess(authProvider, { action: 'catalog' }, 'model catalog')
  if (!Array.isArray(payload.models)) throw new Error('model catalog response is malformed')
  return payload.models.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const displayName = typeof row.display_name === 'string' ? row.display_name.trim() : ''
    const protocols = Array.isArray(row.protocols)
      ? row.protocols.filter(isModelAccessProtocol)
      : []
    return id && displayName && protocols.length > 0
      ? [{
        id,
        displayName,
        protocols,
        enabled: row.enabled === true,
        creditMultipliers: creditMultipliers(row.credit_multipliers),
        contextWindow: positiveIntOrNull(row.context_window),
        reasoningEfforts: parsePlatformReasoningEfforts(row.reasoning_efforts),
        requiresMembership: row.requires_membership === true,
        hidden: row.hidden === true,
      }]
      : []
  })
}

/** 目录/签发里的上下文窗口:只认正整数,其余(缺省、0、负、非数)一律 null → 注入侧不注入该键。 */
function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * 目录里的倍率映射,只留下这台客户端认识的协议和真实的正数。
 *
 * 旧版服务端不带这个字段 → 空表 → UI 只是不显示数字。倍率缺失从来不是错误路径。
 */
function creditMultipliers(value: unknown): Partial<Record<ModelAccessProtocol, number>> {
  if (!value || typeof value !== 'object') return {}
  const parsed: Partial<Record<ModelAccessProtocol, number>> = {}
  for (const [protocol, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isModelAccessProtocol(protocol)) continue
    const ratio = Number(raw)
    if (Number.isFinite(ratio) && ratio > 0) parsed[protocol] = ratio
  }
  return parsed
}

export async function issuePlatformModelAccess(input: {
  authProvider: RuntimeAuthProvider
  agentUserId: string
  engineId: string
  modelId: string
  protocol: ModelAccessProtocol
  providerSessionId?: string | null
  /** 这张票属于哪条会话 —— 只进结清账本,便于从账本追回会话;不发给服务端。 */
  sessionId?: string
  /** 凭据轮换时被替换的那条平台会话:新票继承它启动时给过 harness 的可切清单(#6081)。 */
  keepFromAccessSessionId?: string
}): Promise<IssuedModelAccess> {
  const auth = await requireRuntimeAuth(input.authProvider, 'platform model token')
  const payload = await invokeModelAccessAs(auth, {
    action: 'issue',
    agent_user_id: input.agentUserId,
    engine_id: input.engineId,
    model_id: input.modelId,
    protocol: input.protocol,
    provider_session_id: input.providerSessionId ?? null,
    ...(input.keepFromAccessSessionId ? { keep_from_session_id: input.keepFromAccessSessionId } : {}),
  })
  const protocol = payload.protocol
  if (!isModelAccessProtocol(protocol)) {
    throw new Error('model access response has an invalid protocol')
  }
  const accessSessionId = required(payload.session_id, 'session_id')
  await recordIssuedAccess(auth, accessSessionId, input.sessionId)
  return {
    accessSessionId,
    relayUrl: required(payload.relay_url, 'relay_url').replace(/\/$/, ''),
    token: required(payload.token, 'token'),
    model: required(payload.model, 'model'),
    protocol,
    expiresAt: required(payload.expires_at, 'expires_at'),
    // 缺省即 null → 注入侧按引擎方言处理：能吃自身默认窗口的 harness 省略该键；
    // 配置文档要求 `limit.context` 的 OpenCode 家族在物化时响亮失败，绝不发无效文档。
    contextWindow: positiveIntOrNull(payload.context_window),
    reasoningEfforts: parsePlatformReasoningEfforts(payload.reasoning_efforts),
    switchableModels: switchableModels(payload.switchable_models),
    callableRoutes: callableRoutes(payload.callable_routes),
    membershipLocked: membershipLockedAliases(payload.membership_locked),
    ...(typeof payload.model_id === 'string' && payload.model_id.trim()
      ? { modelId: payload.model_id.trim() }
      : {}),
  }
}

/**
 * 服务端报的可切集合。形状不对的条目**逐条丢掉**而不是整单抛:少一条候选只是少一个可选模型,
 * 而抛出去会让一条本来跑得动的会话开不起来 —— 这一项是「还能换到哪些」,不是「这次用哪个」。
 * 整项缺席(旧版 edge function)⇒ 空数组 ⇒ 注入侧退回单模型形态。
 */
function switchableModels(
  value: unknown,
): IssuedModelAccess['switchableModels'][number][] {
  if (!Array.isArray(value)) return []
  const out: IssuedModelAccess['switchableModels'][number][] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const alias = typeof row.alias === 'string' ? row.alias.trim() : ''
    if (!alias) continue
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : alias
    const displayName = typeof row.display_name === 'string' && row.display_name.trim()
      ? row.display_name.trim()
      : id
    out.push({
      id, displayName, alias,
      contextWindow: positiveIntOrNull(row.context_window),
      reasoningEfforts: parsePlatformReasoningEfforts(row.reasoning_efforts),
    })
  }
  return out
}

const accessLog = createLogger('model-access')

/**
 * 服务端报的「路由 → 能调的模型」。与 `switchableModels` 同一条纪律:形状不对的**逐条丢掉**,❌ 整单抛 ——
 * 这一项只决定 harness 要不要多开一个内置工具,而抛出去会让一条本来跑得动的会话开不起来。
 * 整项缺席(老服务端)⇒ 空表,不出声;**在场却丢了东西**就记一笔 —— 否则服务端契约坏掉与「老服务端」
 * 在产品面上一模一样(出图工具不在),而排查要从界面一路挖到 edge function。
 */
/** 服务端 `membership_locked`:签发与续期同一个形状,坏值丢掉。 */
function membershipLockedAliases(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((alias) => typeof alias === 'string' && alias.trim() ? [alias.trim()] : [])
    : []
}

function callableRoutes(value: unknown): PlatformCallableRoutes {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    accessLog.warn({ received: typeof value }, 'model access callable_routes is not an object; ignoring it')
    return {}
  }
  const out: Record<string, readonly string[]> = {}
  const dropped: string[] = []
  for (const [route, models] of Object.entries(value as Record<string, unknown>)) {
    const callable = Array.isArray(models)
      ? models.flatMap((model) => typeof model === 'string' && model.trim() ? [model.trim()] : [])
      : []
    if (Array.isArray(models) && callable.length !== models.length) dropped.push(route)
    // 键是网关路由**原文**(契约),❌ 不修剪:修剪会让两个键撞成一个、后者静默盖掉前者。
    if (route.trim() && callable.length > 0) out[route] = callable
    else dropped.push(route)
  }
  if (dropped.length > 0) {
    accessLog.warn({ routes: [...new Set(dropped)] }, 'model access callable_routes had malformed or empty entries; dropped them')
  }
  return out
}

/**
 * 撤销并结清一张平台票。成功才删账本那一行;失败时那一行留着(带上失败原文),原错误照抛 ——
 * 调用方负责响亮记一笔,下次启动由 settleResidualPlatformModelAccess 重试。
 */
export async function revokePlatformModelAccess(
  authProvider: RuntimeAuthProvider,
  accessSessionId: string,
): Promise<void> {
  try {
    await invokeModelAccess(authProvider, { action: 'revoke', session_id: accessSessionId }, 'platform model settlement')
  } catch (error) {
    // 记失败原文是附带的;记不下也要把**撤销的原错误**原样抛出去(调用方靠它分 404 与其它失败)。
    await noteRevokeFailure(accessSessionId, error).catch((noteError: unknown) => {
      ledgerLog.error({ accessSessionId: accessSessionId, err: noteError }, '平台票撤销失败,且写入失败原文也失败')
    })
    throw error
  }
  // 撤销已经成功:删不掉账本行不是撤销失败。留着的行下次启动再撤一遍(服务端幂等)再删。
  await rm(accessLedgerPath(accessSessionId), { force: true }).catch((error: unknown) => {
    ledgerLog.error({ accessSessionId: accessSessionId, err: error }, '平台票已撤销,但删除账本行失败;下次启动会再结清一次')
  })
}

const ledgerLog = createLogger('platform-access-ledger')

/**
 * @@@platform-access-ledger - 签出去、还没结清的平台票,一张一个文件(`<GUGU_HOME>/platform-access/<id>.json`)。
 *
 * 为什么要落盘:内存里那张表随进程一起死。应用退出(尤其被信号终止)来不及撤销的票,以前就只能等它在网关上
 * 自然过期,期间凭据仍然有效、额度仍被占着、账单结不上 —— #4467/#6185 读数:SIGTERM 之后 29 张一张没撤。
 * 签发成功即写、撤销成功才删,所以「文件还在」恰好等于「这张票还没被我们结清」,不需要第二个真相。
 *
 * 一票一文件而不是一个总表:同一 GUGU_HOME 下可能有几个实例并发签发/撤销,各写各的文件就没有读改写竞争。
 * 文件里记签发进程的 pid 与启动时刻,启动结清只收「写它的进程已经不在」的那些 —— 别的活实例手里的票不归我们撤。
 * 文件只含撤销需要的标识(id、属主、签发进程、签发时刻、会话),❌ 令牌、❌ 中转地址。0600,目录 0700。
 */
type AccessLedgerEntry = {
  accessSessionId: string
  /** 撤销以票的属主身份调用 ⇒ 结清只能在这个账号登录时进行。 */
  ownerUserId: string
  /**
   * 签发进程 = pid + 它的启动时刻。两者都对上才算「那个进程还活着、票还在用」,结清不碰;
   * 只看 pid 会被复用骗过去(重启后同一个 pid 落到无关进程上,这张票就永远结不了)。
   */
  pid: number
  processStartedAt: string
  issuedAt: string
  sessionId?: string
  /**
   * 宿主退出时这张票的会话仍在 tmux 里跑、且凭据不经宿主供给(写进进程环境的那类)⇒ 票不撤、行标 detached,
   * 由下次启动的宿主接回续期(会话还活着)或结清(已经死了)。
   */
  detached?: true
  lastRevokeError?: string
}

const ACCESS_LEDGER_DIR = 'platform-access'

function accessLedgerDir(): string {
  return join(resolveGuguHome(process.env), ACCESS_LEDGER_DIR)
}

function accessLedgerPath(accessSessionId: string): string {
  // session id 来自服务端;拼进路径前确认它只是一个 id,不是一段路径。
  if (!/^[A-Za-z0-9_-]+$/.test(accessSessionId)) throw new Error(`refusing to track malformed access session id ${accessSessionId}`)
  return join(accessLedgerDir(), `${accessSessionId}.json`)
}

async function recordIssuedAccess(auth: RuntimeAuth, accessSessionId: string, sessionId?: string): Promise<void> {
  try {
    const entry: AccessLedgerEntry = {
      accessSessionId,
      ownerUserId: auth.userId,
      pid: process.pid,
      processStartedAt: new Date(await ownProcessStartedAt()).toISOString(),
      issuedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    }
    await mkdir(accessLedgerDir(), { recursive: true, mode: 0o700 })
    await atomicWriteText(accessLedgerPath(accessSessionId), `${JSON.stringify(entry)}\n`)
  } catch (error) {
    // 记不下来的票不许交出去:它会变成一张谁都不知道要撤的票。当场撤掉,把写失败原样抛给签发方;
    // 当场撤也失败时,这张票就真的无人知晓了 —— 两个错误一起抛,并记下 id,❌ 吞掉。
    try {
      await invokeModelAccessAs(auth, { action: 'revoke', session_id: accessSessionId })
    } catch (revokeError) {
      ledgerLog.error({ accessSessionId: accessSessionId, err: revokeError }, '平台票记不进账本,当场撤销也失败:这张票没有任何记录')
      throw new AggregateError([error, revokeError], `platform access ${accessSessionId} could not be recorded nor revoked`)
    }
    throw error
  }
}

async function noteRevokeFailure(accessSessionId: string, error: unknown): Promise<void> {
  const path = accessLedgerPath(accessSessionId)
  const entry = await readAccessLedgerEntry(path)
  if (!entry) return
  await atomicWriteText(path, `${JSON.stringify({
    ...entry,
    lastRevokeError: error instanceof Error ? error.message : String(error),
  })}\n`)
}

async function readAccessLedgerEntry(path: string): Promise<AccessLedgerEntry | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const entry = JSON.parse(raw) as Partial<AccessLedgerEntry>
  if (
    typeof entry.accessSessionId !== 'string' || typeof entry.ownerUserId !== 'string'
    || typeof entry.pid !== 'number' || typeof entry.processStartedAt !== 'string'
  ) {
    throw new Error(`malformed platform access ledger entry ${path}`)
  }
  return entry as AccessLedgerEntry
}

let ownStartedAt: Promise<number> | undefined

/**
 * 本进程的启动时刻,**与判活读同一个来源**(OS 进程表)。❌ 用 `Date.now() - uptime` 估:uptime 从 node 初始化
 * 算起,冷启动时比 exec 晚好几秒,与进程表一比就把活进程判死、撤掉它还在用的票。同源读数两边逐字相等。
 */
function ownProcessStartedAt(): Promise<number> {
  ownStartedAt ??= processStartedAt(process.pid).then((at) => {
    if (at === null) throw new Error(`process table has no entry for our own pid ${process.pid}`)
    return at
  })
  ownStartedAt.catch(() => { ownStartedAt = undefined })
  return ownStartedAt
}

/** 某个 pid 现在那个进程的启动时刻;进程不在返回 null。读不出(工具失败)就抛,❌ 当成「不在」。 */
export function processStartedAt(pid: number): Promise<number | null> {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`]]
    : ['ps', ['-o', 'lstart=', '-p', String(pid)]]
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      const text = String(stdout).trim()
      // ps 对不存在的 pid 以 1 退出且无输出;这是「不在」,不是工具失败。
      if (!text) {
        if (!error || (error as { code?: unknown }).code === 1) return resolve(null)
        return reject(error)
      }
      const at = Date.parse(text)
      if (!Number.isFinite(at)) return reject(new Error(`unparseable process start time for pid ${pid}: ${text}`))
      resolve(at)
    })
  })
}

async function issuerStillRunning(entry: AccessLedgerEntry): Promise<boolean> {
  const startedAt = await processStartedAt(entry.pid)
  return startedAt !== null && startedAt === Date.parse(entry.processStartedAt)
}

/** 把这张票标成 detached:宿主退出时不撤,留给下次启动的宿主接回或结清。 */
export async function markPlatformAccessDetached(accessSessionId: string): Promise<void> {
  const path = accessLedgerPath(accessSessionId)
  const entry = await readAccessLedgerEntry(path)
  if (!entry) throw new Error(`no platform access ledger entry for ${accessSessionId}; cannot keep it across host exit`)
  await atomicWriteText(path, `${JSON.stringify({ ...entry, detached: true })}\n`)
}

/**
 * #6264 新宿主认回一张上一个宿主留下的票(它的会话还在 tmux 里跑、凭据由宿主供给):账本行改记本进程、
 * 去掉 detached。之后启动结清看到的是「签发它的进程还活着」,不碰它;本宿主再退出时按当时的情况重新判。
 * 没有这一行(已被结清)就抛 —— 调用方据此改为第一次要票时重签。
 */
export async function claimPlatformAccessForThisProcess(accessSessionId: string): Promise<void> {
  const path = accessLedgerPath(accessSessionId)
  const entry = await readAccessLedgerEntry(path)
  if (!entry) throw new Error(`no platform access ledger entry for ${accessSessionId}`)
  const { detached: _detached, ...rest } = entry
  await atomicWriteText(path, `${JSON.stringify({
    ...rest,
    pid: process.pid,
    processStartedAt: new Date(await ownProcessStartedAt()).toISOString(),
  })}\n`)
}

export type ResidualAccessSettlement = {
  /** 本次撤销成功的票。 */
  settled: string[]
  /** detached 且其会话仍在运行、由本宿主接回续期的票。 */
  adopted: string[]
  /** 服务端已不认识(404)的票:没有可撤的东西,账本行删掉。 */
  unknown: string[]
  /** 撤销失败、账本行保留待下次重试的票,带失败原文。 */
  failed: { accessSessionId: string; error: string }[]
  /** 属于别的账号,或签发它的那个进程(pid + 启动时刻)还在跑,本次不碰。 */
  skipped: number
}

/**
 * 启动结清:把上一轮进程没来得及撤的票撤掉。只收当前登录账号的、且签发进程(pid + 启动时刻)已经不在的票 ——
 * 撤销以票的属主身份调用,别的账号的票要等那个账号登录;活进程手里的票还在用,不归我们撤。
 * 逐张顺序撤,一张失败不连累其它张;失败的那张账本行留着(带原文),下次启动再试。
 */
export async function settleResidualPlatformModelAccess(
  authProvider: RuntimeAuthProvider,
  /**
   * 仍在运行的 detach 会话(按 conversation id);由宿主提供,这里不认识 tmux。整次结清只取一次快照。
   * 取不到(抛出)时 detached 行记 failed 并保留 —— ❌ 当成「都不在」撤掉仍在跑的进程的票。
   */
  liveDetachedSessions: () => Promise<ReadonlySet<string>>,
): Promise<ResidualAccessSettlement> {
  const result: ResidualAccessSettlement = { settled: [], adopted: [], unknown: [], failed: [], skipped: 0 }
  let liveSnapshot: Promise<ReadonlySet<string>> | undefined
  const live = () => (liveSnapshot ??= liveDetachedSessions())
  let names: string[]
  try {
    names = await readdir(accessLedgerDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  const auth = await requireRuntimeAuth(authProvider, 'platform access residual settlement')
  for (const name of names.filter((it) => it.endsWith('.json'))) {
    let entry: AccessLedgerEntry | null
    try {
      entry = await readAccessLedgerEntry(join(accessLedgerDir(), name))
    } catch (error) {
      // 坏掉的一行不许挡住其它行。它不删:里面可能是一张还没撤的票,留给人看。
      result.failed.push({ accessSessionId: name, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!entry) continue
    if (entry.ownerUserId !== auth.userId) {
      result.skipped += 1
      continue
    }
    try {
      // 判活失败(读不出进程表)抛出,落进下面的 failed:判不了的票不撤,也不假装撤过。
      if (await issuerStillRunning(entry)) {
        result.skipped += 1
        continue
      }
      if (entry.detached && entry.sessionId && (await live()).has(entry.sessionId)) {
        if (await adoptDetachedAccess(authProvider, entry, liveDetachedSessions)) {
          result.adopted.push(entry.accessSessionId)
          continue
        }
      }
      await revokePlatformModelAccess(authProvider, entry.accessSessionId)
      result.settled.push(entry.accessSessionId)
    } catch (error) {
      if (error instanceof ModelAccessHttpError && error.status === 404) {
        await rm(accessLedgerPath(entry.accessSessionId), { force: true })
        result.unknown.push(entry.accessSessionId)
        continue
      }
      result.failed.push({ accessSessionId: entry.accessSessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** 续期链的总寿命上限,与会话页宿主自己的上限同值(sessionpage-platform-model MAX_RENEWED_LIFETIME_MS)。 */
const ADOPTED_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000
/** 剩余寿命低于这个就不再续(不够一个来回),与会话页宿主同值。 */
const ADOPTED_RENEWAL_FLOOR_MS = 30_000
/** 本宿主接回的 detached 租约,按会话:重连路径(#6193)要复用这一张,而不是再签一张。 */
type AdoptedLease = {
  accessSessionId: string
  expiresAt: string
  authProvider: RuntimeAuthProvider
  timer?: ReturnType<typeof setTimeout>
}
const adoptedLeases = new Map<string, AdoptedLease>()

/** 这条会话若有本宿主接回的 detached 租约,返回它(只读)。 */
export function adoptedPlatformAccessForSession(
  sessionId: string,
): { accessSessionId: string; expiresAt: string } | null {
  const lease = adoptedLeases.get(sessionId)
  return lease ? { accessSessionId: lease.accessSessionId, expiresAt: lease.expiresAt } : null
}

/**
 * 宿主退出时处理接回的租约:停掉续期;会话已不在的撤销结清;仍在跑的保持 detached(账本行已记本进程),
 * 交给下次启动。`liveSessions` 为 null = 读不出 tmux,全部保留交给下次启动判定。
 */
export async function settleAdoptedPlatformAccessAtExit(liveSessions: ReadonlySet<string> | null): Promise<void> {
  const leases = [...adoptedLeases.entries()]
  adoptedLeases.clear()
  await Promise.allSettled(leases.map(async ([sessionId, lease]) => {
    if (lease.timer) clearTimeout(lease.timer)
    if (liveSessions === null || liveSessions.has(sessionId)) return
    await revokePlatformModelAccess(lease.authProvider, lease.accessSessionId).catch((error: unknown) => {
      ledgerLog.error({ accessSessionId: lease.accessSessionId, err: error }, '接回的 detached 票撤销失败;账本行保留,下次启动结清')
    })
  }))
}

/**
 * 接回一张 detached 票:本宿主成为它的续期者。先续一次(续不上 = 票已过期或服务端不认,返回 false 交回结清),
 * 把账本行改记本进程(detached 标记保留:本宿主再退出时同样不撤),然后按剩余寿命过半续期;每次续期前先看
 * 那个会话还在不在,不在了就撤销结清。续期链总寿命从签发时刻起算,不超过上限。
 */
async function adoptDetachedAccess(
  authProvider: RuntimeAuthProvider,
  entry: AccessLedgerEntry,
  liveSessions: () => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  let expiresAt: string
  try {
    expiresAt = (await renewPlatformModelAccess(authProvider, entry.accessSessionId)).expiresAt
  } catch (error) {
    ledgerLog.error({ accessSessionId: entry.accessSessionId, err: error }, 'detached 票续期失败,改为撤销结清')
    return false
  }
  await atomicWriteText(accessLedgerPath(entry.accessSessionId), `${JSON.stringify({
    ...entry,
    pid: process.pid,
    processStartedAt: new Date(await ownProcessStartedAt()).toISOString(),
  })}\n`)
  ledgerLog.info({ accessSessionId: entry.accessSessionId, sessionId: entry.sessionId, expiresAt }, 'detached 票已由本宿主接回续期')
  const sessionId = entry.sessionId
  if (!sessionId) return true
  adoptedLeases.set(sessionId, { accessSessionId: entry.accessSessionId, expiresAt, authProvider })
  scheduleAdoptedRenewal(sessionId, entry, expiresAt, liveSessions)
  return true
}

/**
 * 按剩余寿命过半续期接回的租约。每次先复核会话还在:不在了撤销结清;读不出 tmux 就不动它、下一拍再看。
 * 续期失败按剩余寿命折半重试(与会话页宿主自己的续期同一策略),直到剩余不够一个来回 —— 那时让它自然过期,
 * 账本行在,下次启动结清。续期链总寿命从签发时刻起算,不超过上限。
 */
function scheduleAdoptedRenewal(
  sessionId: string,
  entry: AccessLedgerEntry,
  expiresAt: string,
  liveSessions: () => Promise<ReadonlySet<string>>,
): void {
  const lease = adoptedLeases.get(sessionId)
  if (!lease || lease.accessSessionId !== entry.accessSessionId) return
  const remaining = Date.parse(expiresAt) - Date.now()
  if (Date.now() >= Date.parse(entry.issuedAt) + ADOPTED_MAX_LIFETIME_MS || remaining <= ADOPTED_RENEWAL_FLOOR_MS) {
    ledgerLog.error({ accessSessionId: entry.accessSessionId, expiresAt }, 'detached 票不再续期,将自然过期,由下次启动结清')
    return
  }
  lease.timer = setTimeout(() => {
    void (async () => {
      if (adoptedLeases.get(sessionId) !== lease) return
      let running: boolean
      try {
        running = (await liveSessions()).has(sessionId)
      } catch (error) {
        ledgerLog.error({ accessSessionId: entry.accessSessionId, err: error }, '读不出 tmux 会话,detached 票这一拍不动')
        scheduleAdoptedRenewal(sessionId, entry, expiresAt, liveSessions)
        return
      }
      if (!running) {
        ledgerLog.info({ accessSessionId: entry.accessSessionId }, 'detached 会话已结束,撤销结清它的票')
        adoptedLeases.delete(sessionId)
        await revokePlatformModelAccess(lease.authProvider, entry.accessSessionId)
        return
      }
      let next = expiresAt
      try {
        next = (await renewPlatformModelAccess(lease.authProvider, entry.accessSessionId)).expiresAt
        lease.expiresAt = next
      } catch (error) {
        ledgerLog.error({ accessSessionId: entry.accessSessionId, err: error }, 'detached 票续期失败,按剩余寿命折半重试')
      }
      scheduleAdoptedRenewal(sessionId, entry, next, liveSessions)
    })().catch((error: unknown) => {
      ledgerLog.error({ accessSessionId: entry.accessSessionId, err: error }, 'detached 票结清失败;账本行保留,下次启动结清')
    })
  }, Math.floor(remaining / 2))
  lease.timer.unref?.()
}

/** Settle every request currently visible for a live session without revoking its credential. */
export async function checkpointPlatformModelAccess(
  authProvider: RuntimeAuthProvider,
  accessSessionId: string,
): Promise<void> {
  await invokeModelAccess(
    authProvider,
    { action: 'checkpoint', session_id: accessSessionId },
    'platform model usage checkpoint',
  )
}

/**
 * 把这条会话的凭据有效期往后推,返回新的到期时刻。
 *
 * 只推时间:不新签 token、不换 key(注入给 harness 的凭据在启动时就写进进程环境了,换不了),
 * 也不追加额度(额度的唯一边界是额度窗口)。
 *
 * `membershipLocked`:会员中途到期后,续过的令牌不再放行的那几个网关别名(服务端 `membership_locked`,#7056)。
 * 老服务端不带 ⇒ 空。harness 手里还列着它们 —— 调用方据此在下一轮说清原因,❌ 悄悄换模型。
 */
export async function renewPlatformModelAccess(
  authProvider: RuntimeAuthProvider,
  accessSessionId: string,
): Promise<{ expiresAt: string; membershipLocked: readonly string[] }> {
  const payload = await invokeModelAccess(
    authProvider,
    { action: 'renew', session_id: accessSessionId },
    'platform model renewal',
  )
  const locked = membershipLockedAliases(payload.membership_locked)
  return { expiresAt: required(payload.expires_at, 'expires_at'), membershipLocked: locked }
}

export async function resolveAgentModelLaunch(input: {
  authProvider: RuntimeAuthProvider
  env: NodeJS.ProcessEnv
  agentUserId: string
  engineId: string
  providerSessionId?: string | null
  sessionId?: string
  /**
   * 这次启动的模型决定,由调用方给定;不给则读 agent 级 `model_access`(聊天/ACP 侧的既有用途)。
   *
   * 会话页的 composer 是会话的唯一决策点,选择跟着**会话**走而不是跟着 agent 走 —— 同一个 agent
   * 的两个会话可以一个上平台、一个纯 BYOK,所以那条路径把决定显式传进来,不再回头问 agent 的默认值。
   */
  selection?: AgentModelSelection
}): Promise<{
  selection: AgentModelSelection
  model: string | null
  env: NodeJS.ProcessEnv
  access: IssuedModelAccess | null
}> {
  // 同上:存下来的协议可能是旧的,签令牌前按引擎重新算 —— 白名单与计费那一栏都看它。
  const selection = agentModelSelectionForProtocol(
    input.selection ?? await agentLevelModelSelection(input.agentUserId, input.env),
    platformProtocolForEngine(input.engineId),
  )
  if (selection.source === 'default') return { selection, model: null, env: {}, access: null }
  if (selection.source === 'byok') return { selection, model: selection.modelId, env: {}, access: null }

  const access = await issuePlatformModelAccess({
    authProvider: input.authProvider,
    agentUserId: input.agentUserId,
    engineId: input.engineId,
    modelId: selection.modelId,
    protocol: selection.protocol,
    providerSessionId: input.providerSessionId,
    sessionId: input.sessionId,
  })
  return {
    selection,
    model: access.model,
    access,
    env: platformModelAccessEnv(
      access.protocol,
      access.relayUrl,
      access.token,
      access.contextWindow,
    ),
  }
}

/** agent 级默认(聊天/ACP 侧的既有语义);本机没有这个 agent 的记录就是「没配过」。 */
async function agentLevelModelSelection(
  agentUserId: string,
  env: NodeJS.ProcessEnv,
): Promise<AgentModelSelection> {
  const agent = await findLocalAgentByUserId(agentUserId, env)
  return agent ? cachedAgentModelSelection(agent) : { source: 'default' }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`model access response is missing ${field}`)
  return value.trim()
}
