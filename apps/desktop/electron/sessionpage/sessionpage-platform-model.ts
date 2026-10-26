// @@@sessionpage TASKPAGE-FUSION — platform model quota for session-page sessions.
//
// The session page ships every agent the session backend supports, and each one spawns through the same
// pty hook. So platform access is applied there, once, for whatever provider is starting:
// the session's gugu agent identity decides whether this run uses the user's own setup,
// their BYOK provider, or Gugu's platform quota, and only the last one injects anything.
//
// Nothing here names an agent. An agent becomes eligible by declaring `sessionBundle.platform`
// in its plugin (see platformProtocolForEngine); this module only asks the shared
// resolver what environment that decision produces, so onboarding one more agent never
// means editing this file.

import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeAuthError, type AgentModelSelection, type RuntimeAuthProvider } from '@gugu/core'
import type { AcpPlatformInjection } from '@gugu/session-core/acp'
import { MODEL_CONFIG_DIALECT, platformArmedEffort, type HarnessSessionSurface, type PlatformCallableRoutes } from '@gugu/session-core/agents/plugins'
import {
  CODEX_ACTOR_AUTHORIZATION_HEADER,
  codexPlatformProviderArgs,
  pluginRegistry,
  resolveSessionpageCredentialLifecycle,
  type CodexPlatformAuthRequest,
} from '@gugu/session-plugins/agents'
import {
  buildAcpModelCapability,
  materializeModelCapability,
  positiveWindow,
  providerDeliversModelViaConfigFile,
  type SessionModelCapability,
} from '../capability-bundle'
import {
  dialectModelArgsTargetVisibleClient,
  findInjectionContract,
  injectionDialectForEngine,
  hasCredentialSink,
  platformProtocolForEngine,
  needsSettingsDocument,
  settingsDocumentGoesOnVisibleClientArgv,
  type InjectionSurface,
} from '../engine-injection-contract'
import {
  checkpointPlatformModelAccess,
  claimPlatformAccessForThisProcess,
  issuePlatformModelAccess,
  markPlatformAccessDetached,
  renewPlatformModelAccess,
  settleAdoptedPlatformAccessAtExit,
  modelAccessFailureReason,
  type ModelAccessFailureReason,
  resolveAgentModelLaunch,
  revokePlatformModelAccess,
} from '../model-access'
import { guguCatalogReasonCode, guguReasonInText } from '@gugu/session-core/session-record/contract'
import { createLogger } from '../lib/logger'
import { getSessions } from '../session/main/core/sessions/getSessions'
import { agentEndpointServer, EndpointPorts, listenStable, PersistedRecords, PrivateJsonFile, type EndpointLog } from '../session/main/lib/stable-endpoint'
import { recordModelSource } from '../session/main/core/usage/model-source-recorder'
import { guguAgentUserIdForSession } from './sessionpage-session-agent'
import type { PlatformCredentialRuntimeObservation } from './sessionpage-platform-recovery'
import { hostCatalog, type HostCatalog } from '../../shared/host-localization'
import { quoteShellArg } from '../session/main/utils/shellEscape'

import { proxyPlatformCredentialRequest, withinCredentialDeadline } from './platform-credential-proxy'

const log = createLogger('sessionpage/platform-model')

/** Sessions holding a platform token, so the token is released when the session ends. */
const activeAccessSessions = new Map<string, {
  accessSessionId: string
  authProvider: RuntimeAuthProvider
  /** 续期定时器;会话一结束就必须清掉,否则我们会替一个已经不存在的会话续命。 */
  renewTimer?: ReturnType<typeof setTimeout>
  /** Coalesce duplicate provider stop events for the same turn boundary. */
  checkpointPromise?: Promise<void>
  /** Another boundary arrived while the current checkpoint was in flight; run one trailing pass. */
  checkpointRequested?: boolean
  /** 续期链的总寿命上限(时刻);过了就不再续,见 MAX_RENEWED_LIFETIME_MS。 */
  renewUntil: number
  /** 这次会话的 settings 覆盖文件(含中转令牌),会话结束时删除。 */
  settingsPath?: string
  /** Claude's credential helper (0600 data file) and the 0600 curl config holding the endpoint secret. */
  credentialConfigPath?: string
  helperPath?: string
  credentialRoute?: string
  /** Current upstream credential and relay; loopback proxy consumers never receive either directly. */
  token: string
  relayUrl: string
  /** A failed renewal is repaired by the next helper request instead of serving a known-stale token. */
  renewalFailedAt?: number
  /**
   * 这一档走不到的网关别名(签发 / 续期回的 `membership_locked`,#7056 会员中途到期、#7092 免费档指定了会员模型);
   * 没有 = undefined。每次签发、续期重算;变了就告诉界面(刷新目录,通用模式那一行说清、给去路)。
   */
  membershipLocked?: readonly string[]
  /** Claude may ask for a token from several concurrent requests; issue one replacement only. */
  rotationPromise?: Promise<boolean>
  agentUserId?: string
  providerId: string
  modelId?: string
  protocol?: import('@gugu/core').ModelAccessProtocol
  /** 这条会话跑在哪个界面上 —— 按界面回收令牌时要用(ACP 运行时进程没了,只该收 Chat UI 那批)。 */
  surface: InjectionSurface
  /** 签发时返回给宿主的完整 launch,reopen 复用 live 推理进程时原样取回(见 heldPlatformModelForSession)。 */
  launch: SessionpagePlatformModel
  observationSink?: (observation: PlatformCredentialRuntimeObservation) => void
}>()

/**
 * #6264 由宿主供给凭据的终端会话(claude 的取票脚本、回环代理)活过宿主进程重启。
 *
 * 这类会话里 agent 手里握着的不是网关令牌,而是「去哪个本机地址、带哪个口令、走哪条路由」来要票 ——
 * 取票脚本、装口令的 curl 配置、settings 文档都是启动时写好的文件。以前宿主一退就把它们连同票一起收掉
 * (「宿主一走就断粮」),tmux 里还活着的 agent 下一轮必然失败。现在照 stable-endpoints 的做法:
 *  · 回环端点绑回同一个端口,口令落盘(0600)不再每个进程随机;
 *  · 每条这样的会话记一行(0600):路由、文件路径、票的 id 与签发身份 —— ❌ 令牌本身不落盘;
 *  · 宿主退出时,tmux 里还活着的会话的票不撤,账本行标 detached(与写进进程环境的那类同一个机制);
 *  · 新宿主在绑回端口**之前**把路由认回来,并把账本行改记本进程(结清巡检不再碰它);第一次有人来要票时
 *    以同一条会话的身份重签一张(keepFromSessionId,旧票随即撤销结清)—— 计费仍归这条会话,不重不漏。
 * 没配置(测试、没有数据目录)时一切照旧。
 */
export type PersistedRelaySession = {
  /** conversation id */
  key: string
  accessSessionId: string
  credentialRoute: string
  settingsPath?: string
  credentialConfigPath?: string
  helperPath?: string
  renewUntil: number
  expiresAt: string | null
  agentUserId?: string
  providerId: string
  modelId?: string
  protocol?: import('@gugu/core').ModelAccessProtocol
  surface: InjectionSurface
}

type RelayPersistence = {
  ports: EndpointPorts
  secret: PrivateJsonFile<{ secret?: string }>
  sessions: PersistedRecords<PersistedRelaySession>
  log: EndpointLog
}

let relayPersistence: RelayPersistence | null = null

/**
 * 宿主启动时调一次(在任何会话要票之前)。认回从这一刻起就是「挂着」的:等它的人(终端腿判沿用、启动结清)
 * 一直等到 restorePlatformRelaySessions 跑完 —— ❌ 靠「唤醒总在认回开跑之后」这种隐含的先后。
 */
export function configurePlatformRelayPersistence(input: { dataDir: string; log: EndpointLog }): void {
  relayPersistence = {
    ports: new EndpointPorts(input.dataDir),
    secret: new PrivateJsonFile(join(input.dataDir, 'platform-relay-secret.json')),
    sessions: new PersistedRecords<PersistedRelaySession>(join(input.dataDir, 'platform-relay-sessions.json')),
    log: input.log,
  }
  relayRestore = new Promise<RelayRestoreInput>((resolve) => { beginRelayRestore = resolve }).then(restoreRelaySessions)
}

/** Test seam. */
export function resetPlatformRelayPersistenceForTest(): void {
  relayPersistence = null
  relayRestore = null
  beginRelayRestore = null
  credentialEndpoint?.server.close()
  credentialEndpoint = undefined
  credentialRoutes.clear()
  for (const held of activeAccessSessions.values()) if (held.renewTimer) clearTimeout(held.renewTimer)
  activeAccessSessions.clear()
}

function persistRelaySession(sessionId: string): void {
  const held = activeAccessSessions.get(sessionId)
  if (!relayPersistence || !held?.credentialRoute || held.surface !== 'tui') return
  relayPersistence.sessions.put({
    key: sessionId,
    accessSessionId: held.accessSessionId,
    credentialRoute: held.credentialRoute,
    ...(held.settingsPath ? { settingsPath: held.settingsPath } : {}),
    ...(held.credentialConfigPath ? { credentialConfigPath: held.credentialConfigPath } : {}),
    ...(held.helperPath ? { helperPath: held.helperPath } : {}),
    renewUntil: held.renewUntil,
    expiresAt: held.launch.expiresAt,
    ...(held.agentUserId ? { agentUserId: held.agentUserId } : {}),
    providerId: held.providerId,
    ...(held.modelId ? { modelId: held.modelId } : {}),
    ...(held.protocol ? { protocol: held.protocol } : {}),
    surface: held.surface,
  })
}

/** 盘上记着的会话用到的文件:开机收尸不能收它们(那些 agent 还在 tmux 里用)。 */
function persistedRelayFiles(): Set<string> {
  const files = new Set<string>()
  for (const record of relayPersistence?.sessions.list() ?? []) {
    for (const file of [record.settingsPath, record.credentialConfigPath, record.helperPath]) if (file) files.add(file)
  }
  return files
}

export type RelayRestoreResult = { restored: string[]; dropped: string[] }

type RelayRestoreInput = {
  authProvider: RuntimeAuthProvider
  liveSessions: () => Promise<ReadonlySet<string>>
}

let relayRestore: Promise<RelayRestoreResult> | null = null
let beginRelayRestore: ((input: RelayRestoreInput) => void) | null = null

/**
 * 新宿主启动:把上一个宿主留下的、会话仍在 tmux 里跑的那几条认回来 —— **在绑回回环端口之前**,
 * 端口一通,旧 agent 的取票请求就有人答。会话已经不在的,收掉它的文件与记录(它的票由账本结清)。
 *
 * 只读本机(盘、tmux、本机账本文件),❌ 不碰网络、不等登录 —— 所以它一定落定;但 tmux 名与账本键是 boot 里段 2 迁移改的,
 * 调用方等 boot 跑完再起它(#7120:先读会把旧名下活着的会话判死)。终端腿判「沿用手里那份」之前
 * 先等它(`platformRelaySessionsRestored`):tmux 里的 agent 一敲早绑的 MCP 端口就会唤醒会话,
 * 认回还没落定时内存里没有那份票,唤醒就会另签一张(PR-7 开机读数:三张同秒签、网关池拒掉其中一张,
 * 被盖掉的 detached 票漏到下次启动才结清)。认回时把账本行改记本进程(也只是本机文件),所以它必须早于
 * settleResidualPlatformModelAccess,结清就不会撤它。
 */
export function restorePlatformRelaySessions(input: RelayRestoreInput): Promise<RelayRestoreResult> {
  // 没配落盘:没有要认回的(restoreRelaySessions 当场返回空)。配了:接上 configure 时挂着的那一个,只跑一次。
  if (!relayRestore || !beginRelayRestore) return restoreRelaySessions(input)
  beginRelayRestore(input)
  return relayRestore
}

/**
 * 认回落定。每个终端会话起步都等它;落定之后立即返回。没配落盘 = 当场落定。
 * 认回失败由发起它的那一处记下,这里只管先后。
 */
export async function platformRelaySessionsRestored(): Promise<void> {
  await relayRestore?.catch(() => undefined)
}

async function restoreRelaySessions(input: RelayRestoreInput): Promise<RelayRestoreResult> {
  const result: RelayRestoreResult = { restored: [], dropped: [] }
  const persistence = relayPersistence
  if (!persistence) return result
  const records = persistence.sessions.list()
  if (records.length === 0) return result
  let live: ReadonlySet<string>
  try {
    live = await input.liveSessions()
  } catch (error) {
    // 读不出 tmux:这一轮谁都不动(不认回、也不丢),下次启动再判 —— ❌ 当成「都不在」。
    persistence.log.warn('读不出 tmux 会话,平台转发口这一轮不认回', { error: String(error) })
    return result
  }
  for (const record of records) {
    if (activeAccessSessions.has(record.key)) continue
    if (!live.has(record.key)) {
      persistence.sessions.remove(record.key)
      await Promise.all([record.settingsPath, record.credentialConfigPath, record.helperPath]
        .filter((file): file is string => Boolean(file))
        .map((file) => rm(file, { force: true }).catch(() => undefined)))
      result.dropped.push(record.key)
      continue
    }
    try {
      await claimPlatformAccessForThisProcess(record.accessSessionId)
    } catch (error) {
      // 账本里没有这张票了(已被结清):认回也拿不到钱包,让第一次要票时重签(rotate 会带同一条会话的身份)。
      persistence.log.warn('认回的平台票不在账本里,第一次要票时重签', { sessionId: record.key, error: String(error) })
    }
    credentialRoutes.set(record.credentialRoute, record.key)
    activeAccessSessions.set(record.key, {
      accessSessionId: record.accessSessionId,
      authProvider: input.authProvider,
      // 令牌没落盘:置空并标「续期失败」,第一次有人来要票时 credentialForRuntimeRequest 以同一条会话重签。
      token: '',
      relayUrl: '',
      renewalFailedAt: Date.now(),
      renewUntil: record.renewUntil,
      settingsPath: record.settingsPath,
      credentialConfigPath: record.credentialConfigPath,
      helperPath: record.helperPath,
      credentialRoute: record.credentialRoute,
      agentUserId: record.agentUserId,
      providerId: record.providerId,
      modelId: record.modelId,
      protocol: record.protocol,
      surface: record.surface,
      launch: {
        ...NOT_ON_PLATFORM,
        accessSessionId: record.accessSessionId,
        expiresAt: record.expiresAt,
        settingsDocumentPath: record.settingsPath ?? null,
      },
    })
    result.restored.push(record.key)
  }
  if (result.restored.length > 0) await ensureCredentialEndpoint()
  persistence.log.info('平台转发口:认回重启前的终端会话', { restored: result.restored.length, dropped: result.dropped.length })
  return result
}

/** Current lease generation for host recovery's late-result guard. */
export function platformCredentialGenerationForSession(sessionId: string): string | null {
  return activeAccessSessions.get(sessionId)?.accessSessionId ?? null
}

/**
 * **盲续**(定时器驱动的 renew 链)的总寿命上限 —— **兜底**,不是主要机制。
 *
 * 主要机制是宿主的 teardown:会话结束 → release → 记录删除 → 续期停止。但那条链路上任何一条没接线的
 * 退出路径,都会让这里的续期把「一个 TTL 内自愈的泄漏」变成永久泄漏:会话永远 expires_at > now()
 * 且 revoked_at 为空 → 永远进不了结算巡检队列 → 真实用量永远结不上账,同时那份预留一直占着额度窗口。
 * (这不是假想:正常退出路径此前就没接 teardown。)
 *
 * 所以**定时器**续期有一个绝对上限:超过就不再盲续,让 token 自然过期、由巡检结算。
 *
 * ⚠️ 上限只管「没人在用也在续」的那条链,❌ 不是会话的寿命。2026-09-25 d22:一条 12 小时的 claude 编程会话
 * 在宿主重启后被这里判了死刑 —— 取票脚本来要票,rotate 因为过了上限拒签,每秒被 curl 重试一次、永远拿不到票。
 * 过了上限之后,凡是**有人在用**(harness 经取票脚本 / 回环中转发来真实请求、用户打开或给这条会话发消息)
 * 就走一遍正常的签发(服务端照常查登录、额度、模型上架),签成了从那一刻重新起算一条新链(见 rotatePlatformLease)。
 * 泄漏的界不变:一个没人用的会话不会来要票,过了上限就自然过期、被巡检结清。
 */
const MAX_RENEWED_LIFETIME_MS = 8 * 60 * 60 * 1000

/**
 * @@@test-seam 缩短盲续上限,只给实机验证「跨过上限后会话照常继续」用(真实上限是 8 小时,没法等)。
 * 不设 = 真实值;设了非正整数 = 忽略。
 */
export const RENEW_LIFETIME_TEST_ENV = 'GUGU_TEST_PLATFORM_RENEW_LIFETIME_MS'

export function renewedLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env[RENEW_LIFETIME_TEST_ENV])
  return Number.isSafeInteger(override) && override > 0 ? override : MAX_RENEWED_LIFETIME_MS
}

/**
 * 把这次会话的 settings 覆盖写成一个**只有本人可读**的临时文件,返回它的路径。
 *
 * 为什么是文件不是内联 JSON:文档里有这次会话的中转令牌。`--settings` 两种形式官方都支持(CLI
 * reference:「a path to a settings JSON file or an inline JSON string」),但内联那种会把令牌写进
 * 命令行 —— 进程表里人人可读,而本仓给凭据定的规矩恰恰是「只走环境,绝不进 argv」。文件形式顺带
 * 也躲开了 Windows 上 cmd.exe 的引号转义(quoteForCmdExe 把 `"` 转成 `^"`,在双引号内是字面量,
 * claude 会起不来或干脆忽略这个参数 —— 那就退回原来的 bug)。
 *
 * 0600 + 一次性文件名;会话结束时由 releasePlatformModelForSession 删掉,进程没能走到那一步
 * (被强杀、断电)时由下次启动的 sweepStalePlatformSettingsFiles 收尸。
 *
 * 文件名带 pid 和一次性随机段,而不是会话 id 的哈希:哈希名是可预测的,同机上别的进程能算出来;
 * 带 pid 才让「这份是谁的、那个谁还活着吗」可判,收尸时不会误删另一个正在跑的实例的文件。
 */
async function writeSessionSettingsFile(
  document: Record<string, unknown>,
): Promise<string> {
  const path = join(tmpdir(), `${SETTINGS_FILE_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}.json`)
  try {
    await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  } catch (error) {
    // 半截文件的名字带着活 pid,开机收尸会一直跳过它 —— 写失败当场收走,别留到进程死后。
    await rm(path, { force: true }).catch(() => undefined)
    throw error
  }
  return path
}

const SETTINGS_FILE_PREFIX = 'gugu-platform-settings-'
const CREDENTIAL_FILE_PREFIX = 'gugu-platform-credential-'

type CredentialEndpoint = {
  server: Server
  started: Promise<{ baseUrl: string; secret: string }>
  secret: string
}

const credentialRoutes = new Map<string, string>()
let credentialEndpoint: CredentialEndpoint | undefined

function credentialRequestAuthorized(request: import('node:http').IncomingMessage, secret: string): boolean {
  const authorization = request.headers.authorization
  return authorization === `Bearer ${secret}`
}

// These local capability hints must not reach the model gateway.
const LOCAL_ONLY_REQUEST_HEADERS = new Set([CODEX_ACTOR_AUTHORIZATION_HEADER])

/** 宿主听「这条会话的哪些模型被会员档收掉了」(#7056):界面据此刷新目录、在下一轮之前停下说清。 */
let membershipListener: ((change: { sessionId: string; locked: readonly string[] }) => void) | null = null

export function configurePlatformMembershipListener(
  listener: ((change: { sessionId: string; locked: readonly string[] }) => void) | null,
): void {
  membershipListener = listener
}

function noteMembershipLocked(
  sessionId: string,
  held: { membershipLocked?: readonly string[] },
  locked: readonly string[],
): void {
  const before = held.membershipLocked ?? []
  held.membershipLocked = locked.length ? locked : undefined
  if (before.length === locked.length && before.every((alias) => locked.includes(alias))) return
  log.warn({ sessionId, locked }, locked.length ? '会员档收掉了这条会话的部分模型' : '这条会话的模型已不再受会员档限制')
  membershipListener?.({ sessionId, locked })
}

async function proxyPlatformRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  sessionId: string,
  suffix: string,
  search: string,
): Promise<void> {
  const held = activeAccessSessions.get(sessionId)
  if (!held?.credentialRoute) throw new Error('platform credential proxy session is not active')
  const credential = async () => {
    try {
      return await withinCredentialDeadline(credentialForRuntimeRequest(sessionId))
    } catch (error) {
      if (error instanceof PlatformCredentialUnavailableError) throw error
      throw new PlatformCredentialUnavailableError('service-unavailable', error)
    }
  }
  await proxyPlatformCredentialRequest(request, response, {
    upstream: () => new URL(`${held.relayUrl.replace(/\/$/, '')}${suffix}${search}`),
    localOnlyHeaders: LOCAL_ONLY_REQUEST_HEADERS,
    credential: async () => {
      const token = await credential()
      await tellCredentialRefusal(sessionId, null)
      return token
    },
    refresh: async (rejected) => {
      const current = activeAccessSessions.get(sessionId)
      if (!current || current !== held) throw new Error('Platform credential session ended')
      // A concurrent refresh may already have replaced the rejected generation.
      if (current.token === rejected) current.renewalFailedAt = Date.now()
      const next = await credential()
      if (next === rejected) {
        throw new PlatformCredentialUnavailableError('service-unavailable', new Error('Rejected platform credential was not replaced'))
      }
      return next
    },
    warn: event => log.warn({ sessionId, path: suffix, ...event, error: event.code }, event.kind === 'stream'
      ? '平台中转:网关中途掐断了回答,给 harness 的那条也当场断开'
      : '平台中转:连不上网关'),
  })
}

function endpointSecret(): string {
  const persistence = relayPersistence
  const stored = persistence?.secret.read()?.secret
  if (typeof stored === 'string' && /^[0-9a-f-]{72}$/i.test(stored)) return stored
  const secret = randomUUID() + randomUUID()
  // 写不进(磁盘满)也照常工作:只是这一代的会话活不过下一次重启。
  persistence?.secret.write({ secret })
  return secret
}

async function ensureCredentialEndpoint(): Promise<{ baseUrl: string; secret: string }> {
  if (credentialEndpoint) return credentialEndpoint.started
  const secret = endpointSecret()
  const server = agentEndpointServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.match(/^\/gugu-platform-credentials\/([a-f0-9-]+)$/)?.[1]
    const relay = url.pathname.match(/^\/gugu-platform-relay\/([a-f0-9-]+)(\/.*)$/)
    if (!route && !relay) {
      response.writeHead(404).end()
      return
    }
    if (!credentialRequestAuthorized(request, secret)) {
      response.writeHead(401).end()
      return
    }
    if (route && request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    const credentialRoute = route ?? relay?.[1]
    const sessionId = credentialRoute ? credentialRoutes.get(credentialRoute) : undefined
    if (!sessionId) {
      response.writeHead(404).end()
      return
    }
    if (relay) {
      void proxyPlatformRequest(request, response, sessionId, relay[2], url.search).catch(async (error) => {
        log.error({ sessionId, err: error }, '平台 credential relay 转发失败')
        const unavailable = credentialUnavailableMessage(error)
        // 签不出票 = 4xx(harness 不重试,当场把原因显示出来);❌ 5xx:codex / opencode 会对 5xx 自己退避重试一整轮。
        // 错误体同时满足 Anthropic(`type:error` + `error.type`)与 OpenAI(`error.message`)两种形状。
        if (unavailable && !response.headersSent) {
          await tellCredentialRefusal(sessionId, error)
          response.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', code: 'gugu_credential_unavailable', message: unavailable } }))
          return
        }
        if (!response.headersSent) response.writeHead(502).end()
        else response.destroy(error instanceof Error ? error : undefined)
      })
      return
    }
    void (async () => {
      try {
        const token = await credentialForHelperRequest(sessionId)
        await tellCredentialRefusal(sessionId, null)
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(`${token}\n`)
      } catch (error) {
        log.error({ sessionId, err: error }, '平台 credential helper 取票失败')
        const unavailable = credentialUnavailableMessage(error)
        if (unavailable) {
          await tellCredentialRefusal(sessionId, error)
          // 403 = 取票脚本里的 curl 不重试(只重试连不上与 408/429/5xx),脚本把正文写到 stderr、以非零退出,
          // claude 显示成 `apiKeyHelper failed: exited 1: <这一句>`(Claude Code 2.1.281 实测)。
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          response.end(`${unavailable}\n`)
          return
        }
        response.writeHead(500).end()
      }
    })()
  })
  server.unref()
  const persistence = relayPersistence
  const started = persistence
    ? listenStable(server, { name: 'platform-credential', ports: persistence.ports, log: persistence.log }).then(({ port }) => {
        server.on('error', (error) => log.error({ err: error }, '平台 credential helper endpoint 失败'))
        return { baseUrl: `http://127.0.0.1:${port}`, secret }
      })
    : new Promise<{ baseUrl: string; secret: string }>((resolve, reject) => {
    server.once('error', reject)
    server.on('error', (error) => log.error({ err: error }, '平台 credential helper endpoint 失败'))
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('platform credential helper endpoint did not bind loopback'))
        return
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, secret })
    })
  })
  credentialEndpoint = { server, started, secret }
  return started
}

/**
 * @@@windows-credential-helper — Claude 的 `apiKeyHelper` 在 Windows 上必须是 `.cmd`,不能是 `.sh`。
 *
 * 2026-09-19 在 chole(Windows 11 / Claude Code 2.1.278)上拿真 `claude.exe` 实测三种形状,
 * 每种都让 helper 先写一个标记文件,再 echo 一个值:
 *
 * | helper 形状 | 跑没跑(标记文件) | claude 拿到值了吗 |
 * |---|---|---|
 * | `.sh`(本函数改之前写出来的那种) | **跑了** | **没有** —— `apiKeyHelper failed: did not return a value` |
 * | `.cmd` | 跑了 | 拿到了 |
 * | `cmd /c …` 命令行 | 跑了 | 拿到了 |
 *
 * ⇒ 坏法**不是「执行不了」而是「执行得了、stdout 取不回来」**:Windows 经文件关联把 `.sh`
 * 交给了另一个进程,claude 等不到输出。这一点很要命 —— 它长得像「helper 没配对」,
 * 于是没人去怀疑文件后缀。
 *
 * 而同一条路上的 `stripClaudeStaticCredentials()` / `dynamicClaudeSettings()` 已经把
 * `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 从 env 与 settings 里删干净了 ——
 * helper 取不到值 = Windows 上平台模型**一个凭据来源都不剩**,每一轮都 401。
 * 网关侧记成 `user 0 | Invalid token`(解不出用户,因为送过去的根本不是一枚令牌),
 * 而宿主的「平台凭据恢复对账」永远报 `expired: []` —— 它只管过期,这里压根没取到过。
 *
 * `%SystemRoot%` 由 `getWindowsEssentialEnv()` 保证在 agent env 里(缺省 `C:\Windows`),
 * 所以不依赖 PATH 里有没有 System32。
 */
/**
 * #6264 宿主重启(升级、崩溃、看门人拉起)那几秒里本机回环端点连不上:取票脚本自己重试,❌ 让 claude
 * 拿到一次「apiKeyHelper 失败」。连不上(connrefused)与 5xx 都重试,每次隔 1 秒,总共最多 30 秒。
 */
const HELPER_RETRY_ARGS = '--retry 15 --retry-connrefused --retry-delay 1 --retry-max-time 30'

export function claudeCredentialHelperFile(
  platform: NodeJS.Platform,
  input: { basePath: string; secret: string; url: string },
): { path: string; contents: string; command: string; config: { path: string; contents: string } } {
  // @@@secret-off-argv —— 端点 secret 只写进一份 0600 的 curl 配置文件,由 `curl --config` 读;
  // ❌ 不放进 helper 的 `-H` 参数:那样每次取票它都出现在 curl 的 argv 里,同机任何用户 `ps` 都看得到。
  // secret 是我们自己生成的(两个 uuid 拼接),配置文件里按 curl 的引号语法写,只允许 [0-9a-f-],
  // 真混进别的字符说明上游生成方式变了:宁可炸,也不写一份解析不对的配置。
  if (!/^[0-9a-f-]+$/i.test(input.secret)) {
    throw new Error('claude credential helper secret is not a hex/uuid string; refusing to write the curl config')
  }
  const config = {
    path: `${input.basePath}.curlrc`,
    contents: `header = "Authorization: Bearer ${input.secret}"\n`,
  }
  if (platform === 'win32') {
    // url = 本机回环地址,config 路径在 tmpdir 下;真出现 cmd 元字符说明上游变了:宁可炸,也不写一份可被注入的 helper。
    for (const [name, value] of [['url', input.url], ['config path', config.path]] as const) {
      if (/["%^&<>|\r\n]/.test(value)) {
        throw new Error(
          `claude credential helper ${name} contains cmd metacharacters; refusing to write an injectable helper`,
        )
      }
    }
    const path = `${input.basePath}.cmd`
    return {
      path,
      command: path,
      config,
      // `-q` 必须是 curl 的第一个参数(只在那个位置才会跳过用户的 .curlrc)。
      contents: '@echo off\r\n'
        + `"%SystemRoot%\\System32\\curl.exe" -q --config "${config.path}" --noproxy "*" --fail --silent --show-error --max-time 10 ${HELPER_RETRY_ARGS} `
        + `"${input.url}"\r\n`,
    }
  }
  // @@@helper-is-data (#5233 / #6207) —— POSIX 上 helper 是**数据文件**(0600),由系统自带的
  // `/bin/sh` 读它;`apiKeyHelper` 写成命令行(claude 用 shell 跑它,Claude Code 2.1.280 实测)。
  // ❌ 别改回「每条会话新写一份 0700 可执行文件、直接 exec」:macOS 对**新可执行文件**的首次执行
  //    要过执行准入,整机积压时排几秒到几分钟(mac1 三臂同时刻实测:新可执行 2.6–20.6 s,
  //    现成二进制 11–19 ms,`/bin/sh <数据文件>` 12–129 ms)。claude 拿不到 key 就发不出任何请求,
  //    界面停在 `Working…` 且无报错;新可执行文件每条会话一份,所以每条会话都付一次。
  // `-q` 必须是 curl 的**第一个**参数:curl 只在那个位置才跳过用户的 ~/.curlrc;放后面静默无效,
  // 用户 .curlrc 里的 `-i` / `-o` / `-w` 就会混进 helper 的输出,claude 拿到的不是票、每轮 401。
  //
  // @@@helper-says-why —— 不用 `--fail`:宿主签不出票时回 403 + 一句给人看的原因,脚本把它写到 stderr 并以
  // 非零退出,claude 原样显示 `apiKeyHelper failed: exited 1: <原因>`。`--write-out` 把状态码接在正文后面
  // (恰好 3 位),`${body%???}` 剥掉它,再剥掉正文自己的末尾换行。
  // curl 自己失败(连不上、超时,重试已用完)→ 非零退出,stderr 是 curl 的那句。
  const path = `${input.basePath}.sh`
  return {
    path,
    command: `/bin/sh ${quoteShellArg(path)}`,
    config,
    contents: '#!/bin/sh\nset -u\n'
      + `body=$(curl -q --config ${quoteShellArg(config.path)} --noproxy '*' --silent --show-error --max-time 10 ${HELPER_RETRY_ARGS} `
      + `--write-out '%{http_code}' ${quoteShellArg(input.url)}) || exit $?\n`
      + 'status=${body#"${body%???}"}\n'
      + 'body=${body%???}\n'
      // 正文自己的那个换行(宿主写的是 `<票>\\n`)夹在状态码前面,`$(…)` 吃不到,这里剥掉。
      + "nl='\n'\n"
      + 'body=${body%"$nl"}\n'
      + 'if [ "$status" = 200 ]; then printf \'%s\\n\' "$body"; exit 0; fi\n'
      + 'if [ -n "$body" ]; then printf \'%s\\n\' "$body" >&2; else echo "credential endpoint returned HTTP $status" >&2; fi\n'
      + 'exit 1\n',
  }
}

async function writeSessionCredentialFiles(
  sessionId: string,
): Promise<{ credentialConfigPath: string; helperPath: string; helperCommand: string; credentialRoute: string }> {
  // 只写取票要用的两份:helper 与装 secret 的 curl 配置,都是 0600 数据文件(没有执行位)。
  // ❌ 不再把网关令牌落盘:helper 经回环端点向宿主要票,令牌只在宿主内存里(见 credentialForRuntimeRequest)。
  // 文件名都带 CREDENTIAL_FILE_PREFIX + pid,release 与启动时的残留清扫按这个前缀收。
  const basePath = join(tmpdir(), `${CREDENTIAL_FILE_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`)
  const credentialRoute = randomUUID()
  const endpoint = await ensureCredentialEndpoint()
  const helperUrl = `${endpoint.baseUrl}/gugu-platform-credentials/${credentialRoute}`
  const helper = claudeCredentialHelperFile(process.platform, {
    basePath,
    secret: endpoint.secret,
    url: helperUrl,
  })
  const helperPath = helper.path
  const credentialConfigPath = helper.config.path
  credentialRoutes.set(credentialRoute, sessionId)
  try {
    await writeFile(credentialConfigPath, helper.config.contents, { mode: 0o600 })
    // 数据文件,不给执行位:POSIX 由 `/bin/sh` 读它,Windows 的 `.cmd` 由 cmd.exe 读它(见 claudeCredentialHelperFile)。
    await writeFile(helperPath, helper.contents, { mode: 0o600 })
  } catch (error) {
    credentialRoutes.delete(credentialRoute)
    await Promise.all([
      rm(credentialConfigPath, { force: true }),
      rm(helperPath, { force: true }),
    ]).catch(() => undefined)
    throw error
  }
  return { credentialConfigPath, helperPath, helperCommand: helper.command, credentialRoute }
}

function stripClaudeStaticCredentials(env: Record<string, string>): Record<string, string> {
  const next = { ...env }
  delete next.ANTHROPIC_AUTH_TOKEN
  delete next.ANTHROPIC_API_KEY
  return next
}

function credentialProxyEnv(
  env: Record<string, string>,
  access: { relayUrl: string; token: string },
  proxy: { baseUrl: string; apiKey: string },
): Record<string, string> {
  const upstreamRoot = access.relayUrl.replace(/\/$/, '')
  const proxyRoot = proxy.baseUrl.replace(/\/v1$/, '')
  const next = Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (value === access.token) return [key, proxy.apiKey]
    const normalized = value.replace(/\/$/, '')
    if (normalized === upstreamRoot) return [key, proxyRoot]
    if (normalized === `${upstreamRoot}/v1`) return [key, proxy.baseUrl]
    return [key, value]
  }))
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const current = next[key]?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []
    next[key] = [...new Set([...current, '127.0.0.1', 'localhost', '::1'])].join(',')
  }
  return next
}

/**
 * @@@static-key-outranks-helper — 这两个键必须**置空**,不能只 `delete`。
 *
 * `delete` 表达的是「我们这份文档不提供静态 key」,而 claude 会把**用户自己的**
 * `~/.claude/settings.json` 合并进来;那里的静态 `ANTHROPIC_API_KEY` **压过 `apiKeyHelper`**,
 * 于是平台会话拿着用户自己的 key 去打咕咕网关,网关解不出用户 ⇒ 每轮 `401 Invalid token`
 * (网关日志记 `user 0`)。置空字符串才是「这一档没有静态 key」,helper 才轮得到。
 *
 * 2026-09-19 在 chole 上拿真 `claude.exe` + 产品真 settings 三向对照
 * (假 Anthropic 端点只记认证头的形状,不记值):
 *
 * | 做法 | claude 在 `/v1/messages` 上送的 key | 是 helper 给的那枚吗 |
 * |---|---|---|
 * | 现状(只 delete) | len=35 `sha=f1dbeeb2…` | **否** —— 用户 settings.json 里的静态 key |
 * | **本改法(置空)** | len=51 `sha=3c3a933f…` | **是** |
 * | 改成 `--setting-sources=project,local` | len=35 | 否 —— 去掉 user 源也没用 |
 *
 * ⇒ 第三行是这条注释存在的理由:**「不读 user 源」看起来是更干净的修法,实测无效**,
 * 别照直觉改回去。
 */
export function dynamicClaudeSettings(
  document: Record<string, unknown>,
  helperCommand: string,
): Record<string, unknown> {
  const env = document.env && typeof document.env === 'object' && !Array.isArray(document.env)
    ? { ...(document.env as Record<string, unknown>) }
    : {}
  env.ANTHROPIC_AUTH_TOKEN = ''
  env.ANTHROPIC_API_KEY = ''
  return { ...document, env, apiKeyHelper: helperCommand }
}

async function credentialForHelperRequest(sessionId: string): Promise<string> {
  const held = activeAccessSessions.get(sessionId)
  if (
    !held
    || held.providerId !== 'claude'
    || !held.credentialConfigPath
  ) throw new Error('platform Claude credential session is not active')

  return credentialForRuntimeRequest(sessionId)
}

/** 按需签发签不出来时,agent 那一侧看到的原因(文案随宿主语言,见 host-localization credentialUnavailable)。 */
export type PlatformCredentialUnavailableKind = keyof HostCatalog['sessionPlatform']['credentialUnavailable']

/** 原因(`modelAccessFailureReason`)→ agent 界面上那一句的键。积分用完不在签发时拒(网关自己说),所以没有那一句。 */
const CREDENTIAL_UNAVAILABLE_COPY: Record<ModelAccessFailureReason, PlatformCredentialUnavailableKind> = {
  'signed-out': 'signedOut',
  'membership-required': 'membership',
  'model-unavailable': 'modelUnavailable',
  'unreachable': 'unreachable',
  'service-unavailable': 'serviceUnavailable',
}

export class PlatformCredentialUnavailableError extends Error {
  readonly kind: PlatformCredentialUnavailableKind
  constructor(readonly reason: ModelAccessFailureReason, cause: unknown) {
    super(`platform runtime credential could not be reissued: ${reason}`, { cause })
    this.name = 'PlatformCredentialUnavailableError'
    this.kind = CREDENTIAL_UNAVAILABLE_COPY[reason]
  }
}

/** 一次签发失败对用户意味着什么。控制面的原话只进日志,❌ 不送到 agent 界面上。 */
export function classifyCredentialIssueFailure(error: unknown): PlatformCredentialUnavailableKind {
  return CREDENTIAL_UNAVAILABLE_COPY[modelAccessFailureReason(error)]
}

/**
 * 按需签发失败后的退避:第 n 次连续失败之后,这条会话 10s·2^(n-1) 内(封顶 5 分钟)的要票请求
 * 当场拿到同一个原因,不打控制面。
 *
 * 频率与代价:取票脚本/回环中转只在 agent 真要发请求时才来(claude 每个请求最多 3 次,官方文档
 * 「Helper failures」),每次命中退避窗口只花一次本机内存查表;打到控制面的签发(一次 model-access
 * issue,含额度查询与网关调用)每条会话最多 10s、20s、40s、80s、160s 各一次,之后每 5 分钟一次。
 * ❌ 以前:rotate 拒签 → 500 → curl `--retry-delay 1` 每秒重打一次,无止境。
 */
export function credentialIssueBackoffMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000)
}

type IssueBackoff = {
  agentUserId: string | undefined
  /**
   * 替哪个模型签失败的(`null` = 签之前说不出,存量会话按 agent 级配置签)。
   * #7092 换了模型(会员模型被拒、换个免费的)= 另一次签发,❌ 拿旧模型的拒绝作答。
   */
  modelId: string | null
  error: PlatformCredentialUnavailableError
  attempts: number
  retryAt: number
}
/**
 * 每条会话最近一次签发失败。取票(credentialForRuntimeRequest)与会话重建(resolvePlatformModelForSession)
 * **共用这一份**判断:退避窗口内两条路都当场给同一个原因,❌ 打控制面。按会话 id 记、❌ 挂在会话手里的那份票上 ——
 * 重建会先结清旧票(那份记录随之没了),挂在票上的话重建一次就绕开了窗口。签成功即清空。
 * #6938 也记下是替哪个 agent 签的:失败说的是那个身份。会话换了身份(云端删了旧的、名册铸了新的),
 * 旧身份的「agent is not owned by caller」❌ 替新身份作答 —— 新身份照常去签。
 */
const issueBackoffs = new Map<string, IssueBackoff>()

function activeIssueBackoff(sessionId: string, agentUserId: string | undefined, modelId: string | null): IssueBackoff | null {
  const backoff = issueBackoffs.get(sessionId)
  return backoff && backoff.agentUserId === agentUserId && sameIssueModel(backoff.modelId, modelId) && Date.now() < backoff.retryAt
    ? backoff
    : null
}

/** 两边都说得出模型、且不是同一个,才算换了模型;有一边说不出就按同一次签发(与改动前一致)。 */
function sameIssueModel(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b
}

function recordIssueFailure(
  sessionId: string,
  agentUserId: string | undefined,
  modelId: string | null,
  error: unknown,
): IssueBackoff {
  const unavailable = new PlatformCredentialUnavailableError(modelAccessFailureReason(error), error)
  // 本机还没登录(请求根本没发出去)不记退避:照样失败、照样说原因,但退避护的是控制面,这一下打不到它 ——
  // 记下了,登录后的第一次要票还要白等一个窗口(开机认回之后,登录前来要票是常态)。
  // 控制面回的 401(登录失效)照旧退避:那一下是真打到了。
  if (error instanceof RuntimeAuthError) {
    issueBackoffs.delete(sessionId)
    return { agentUserId, modelId, error: unavailable, attempts: 0, retryAt: Date.now() }
  }
  const previous = issueBackoffs.get(sessionId)
  const sameTarget = previous && previous.agentUserId === agentUserId && sameIssueModel(previous.modelId, modelId)
  const attempts = (sameTarget ? previous.attempts : 0) + 1
  const backoff = { agentUserId, modelId, error: unavailable, attempts, retryAt: Date.now() + credentialIssueBackoffMs(attempts) }
  issueBackoffs.set(sessionId, backoff)
  return backoff
}

/** 测试口:用例之间别把上一条留下的退避带过去。 */
export function resetPlatformIssueBackoffsForTest(): void {
  issueBackoffs.clear()
}

/** 人点了重试(起任务页 / 私聊横幅的重试、恢复重试、「我开好了」):这条会话真去问一次,❌ 拿窗口里的旧原因作答(#7103)。 */
export function clearPlatformIssueBackoff(sessionId: string): void {
  issueBackoffs.delete(sessionId)
}

let credentialUnavailableCopy: () => HostCatalog['sessionPlatform']['credentialUnavailable'] =
  () => hostCatalog('zh-CN').sessionPlatform.credentialUnavailable

/** 宿主启动时接上当前界面语言(测试里不接 = 中文)。 */
export function configurePlatformCredentialCopy(
  copy: () => HostCatalog['sessionPlatform']['credentialUnavailable'],
): void {
  credentialUnavailableCopy = copy
}

/** 给 agent 界面看的那一句;认不出的失败(会话已结束之类)返回 null,由调用方按内部错误处理。 */
export function credentialUnavailableMessage(error: unknown): string | null {
  return error instanceof PlatformCredentialUnavailableError ? credentialUnavailableCopy()[error.kind] : null
}

/**
 * #7103 通用形态的转录是咕咕自己的界面:取票被咕咕拒时,先把原因递进这条会话进行中的那一轮(announceSession),
 * **送到了才回 403** —— 这一家知道拿不到票之前,原因已经在那一轮手上,结算时按原因表说;不靠时间窗对。
 * 同一轮里后来又签出来了,先撤掉再交票。终端会话不在 ACP 运行时里(delivered:false),照旧只靠 403 正文那一句。
 */
type CredentialRefusalSink = (sessionId: string, code: string | null) => Promise<unknown>
let credentialRefusalSink: CredentialRefusalSink | null = null
const refusalTold = new Set<string>()

export function configurePlatformCredentialRefusalSink(sink: CredentialRefusalSink | null): void {
  credentialRefusalSink = sink
}

/** 递原因最多等这么久:ACP 运行时卡住时取票请求不能跟着挂住(helper 的 curl `--max-time 10`),超时照旧回 403。 */
const REFUSAL_DELIVERY_TIMEOUT_MS = 2_000

async function tellCredentialRefusal(sessionId: string, error: unknown): Promise<void> {
  const code = error instanceof PlatformCredentialUnavailableError ? guguCatalogReasonCode(error.reason) : null
  if (!credentialRefusalSink || (code === null && !refusalTold.delete(sessionId))) return
  if (code !== null) refusalTold.add(sessionId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), REFUSAL_DELIVERY_TIMEOUT_MS) })
  const outcome = await Promise.race([credentialRefusalSink(sessionId, code), timedOut]).catch((err: unknown) => err)
  clearTimeout(timer)
  if (outcome === 'timeout' || outcome instanceof Error) {
    log.error({ sessionId, code, err: outcome }, '取票被拒的原因没递进会话;照旧回 403')
  }
}

export async function credentialForRuntimeRequest(sessionId: string): Promise<string> {
  const held = activeAccessSessions.get(sessionId)
  if (!held?.credentialRoute) throw new Error('platform runtime credential session is not active')

  if (held.rotationPromise) await held.rotationPromise

  // The helper/relay is the last wall-clock check before a harness sends a request. A stale timer
  // must never turn into a stale token: expiry and an observed renewal failure both rotate
  // the lease before the token is returned to the harness.
  if (!held.token || platformModelIsExpired(held.launch) || held.renewalFailedAt !== undefined) {
    const usable = () => Boolean(held.token) && !platformModelIsExpired(held.launch)
    const backoff = activeIssueBackoff(sessionId, held.agentUserId, held.modelId ?? null)
    if (backoff) {
      // 退避窗口内:还有没过期的令牌就先用着,没有就当场给出同一个原因 —— ❌ 不打控制面。
      if (!usable()) throw backoff.error
    } else {
      try {
        if (!await rotatePlatformLease(sessionId)) {
          throw new Error('platform runtime credential session cannot rotate in place')
        }
      } catch (error) {
        if (activeAccessSessions.get(sessionId) !== held) throw error
        const { error: unavailable, attempts, retryAt } = recordIssueFailure(sessionId, held.agentUserId, held.modelId ?? null, error)
        held.observationSink?.({
          generation: held.accessSessionId,
          source: 'lease',
          observedAt: new Date().toISOString(),
          leaseExpiresAt: held.launch.expiresAt,
          operation: 'issue',
          outcome: 'failure',
          classification: unavailable.kind,
        })
        // A failed renewal does not necessarily mean the current token has expired. Keep that
        // still-valid token usable while surfacing the replacement failure. Once wall-clock
        // expiry is reached, fail loud — fast, with a reason the harness shows the user.
        log.error(
          { sessionId, kind: unavailable.kind, attempts, retryAt: new Date(retryAt).toISOString(), err: error },
          usable() ? '平台运行时令牌重新签发失败，暂继续使用当前未过期令牌' : '平台运行时令牌重新签发失败，退避后再试',
        )
        if (!usable()) throw unavailable
      }
    }
  }
  const current = activeAccessSessions.get(sessionId)
  const token = current?.token
  if (!token) throw new Error('platform runtime credential is unavailable')
  return token
}

/** Check a plugin-declared user model allowlist before minting platform quota. */
export async function assertUserModelAllowed(
  env: NodeJS.ProcessEnv,
  providerId: string,
  modelId: string,
): Promise<void> {
  const model = modelId.trim()
  if (!model) return
  const models = pluginRegistry.get(providerId)?.capabilities.models
  const allowlist = models?.kind === 'selectable' ? models.userAllowlist : undefined
  if (!allowlist) return
  const configuredRoot = allowlist.envVar ? env[allowlist.envVar]?.trim() : undefined
  const file = configuredRoot
    ? join(configuredRoot, allowlist.file.split('/').at(-1)!)
    : join(env.HOME?.trim() || homedir(), allowlist.file)
  let document: unknown
  try {
    document = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(
      `无法读取用户设置 ${file}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let current: unknown = document
  for (const segment of allowlist.pointer.slice(1).split('/')) {
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined
  }
  const availableModels = current
  if (!Array.isArray(availableModels)) return
  const allowed = availableModels.some((entry) => typeof entry === 'string' && entry.trim() === model)
  if (!allowed) {
    const pointer = allowlist.pointer.slice(1).split('/').filter(Boolean).join('.')
    throw new Error(
      `你的 ~/${allowlist.file} ${pointer} 排除了该模型 '${model}'。`
      + '请移除该限制或在引擎设置中加入该模型。',
    )
  }
}
/**
 * 会话页 claude **TUI** 会话的 settings 基线:关掉 agent view。
 *
 * pty 里跑的就是 claude 本体,它的 agent view 快捷键会截住会话页自己的键位(owner 2026-08-10
 * 拍板启动即禁用,#3323)。走 `--settings` 而不是 spawn env,理由与中转键相同:用户
 * `~/.claude/settings.json` 压得住进程环境,只有这一层压不掉。
 *
 * 只给 TUI:Chat UI 那条路是 headless claude,没有 TUI 快捷键可冲突,而 `disableAgentView`
 * 顺带关闭后台 agent 功能 —— 加给聊天会话是无缘由的能力削减。
 */
const CLAUDE_TUI_BASE_SETTINGS = {
  disableAgentView: true,
  // `--dangerously-skip-permissions` 的免责声明对话框只认这个 settings 键(claude 2.1.259:
  // `i$()` 读 userSettings/localSettings/flagSettings/policySettings 的
  // skipDangerousModePermissionPrompt;`.claude.json` 的 bypassPermissionsModeAccepted 是它的
  // 旧位,新版启动时会迁进 settings)。咕咕只在用户在自己界面上选了 auto-approve 时才传那个
  // flag —— 那一下就是知情同意,再弹一次只会把首句吞进对话框(#4765 同族)。不传 flag 时这个键
  // 无人读取。走 --settings 而不是写用户 `~/.claude/settings.json`:runtime 注入,不落地。
  skipDangerousModePermissionPrompt: true,
} as const

let claudeTuiBaseSettingsPromise: Promise<string> | undefined

/**
 * BYOK claude TUI 会话没有平台 settings 文档,agent view 的禁用仍要有 `--settings` 可挂 ——
 * 这份是**无密钥**的进程级静态文档,一个进程写一次、所有 BYOK 会话共用。
 *
 * 命名沿用平台文档的前缀 + 本进程 pid:开机收尸(sweepStalePlatformSettingsFiles)按 pid 判活,
 * 进程死后由下次启动收走,不需要自己的清理路径。写失败不兜底(fail loud),但清掉 memo 并收走
 * 可能的半截文件,下一条会话可以重试而不是永远复用一个 rejected promise。
 *
 * 每次取用都**复查文件还在**:electron 一跑就是几天,而 tmpdir 归 OS 清扫(macOS 按最近访问
 * 约 3 天收,Linux systemd-tmpfiles 同类)。memo 终身握着一条被收走的路径,就是把之后每条
 * BYOK 会话都送进 `claude --settings <missing>` 的启动即死(claude 对缺失文档 fail loud)。
 * 文件没了不是错误,是 tmp 文件的正常一生 —— 重写一份即自愈。
 */
export function claudeTuiBaseSettingsFile(): Promise<string> {
  claudeTuiBaseSettingsPromise = (claudeTuiBaseSettingsPromise ?? Promise.resolve(''))
    .then(async (path) => {
      if (path) {
        try {
          await access(path)
          return path
        } catch { /* OS 清扫收走了 —— 重写自愈 */ }
      }
      try {
        return await writeSessionSettingsFile({ ...CLAUDE_TUI_BASE_SETTINGS })
      } catch (error) {
        claudeTuiBaseSettingsPromise = undefined
        throw error
      }
    })
  return claudeTuiBaseSettingsPromise
}

/**
 * claude TUI 会话 argv 上「为禁掉 agent view 而追加」的那一段 —— 单一出口(#3323)。
 *
 * 三种输入三种答案,每一条都有单测钉着:
 * - 平台会话:[]。禁用键已合进它的会话 settings 文档(claude 只认一个 `--settings`,追加第二个
 *   就是两份文档抢一个槽位)。
 * - 会话 argv 里已有用户自己的 `--settings`(会话页 Extra args 显式配置):[]。claude 对重复
 *   `--settings` 是 last-wins,追加我们的会把用户整份 settings 静默顶掉 —— 显式接管 settings 层
 *   的用户保住他的配置,代价是他的 agent view 维持他自己的设置。
 * - 其余(BYOK):挂进程级静态文档。
 */
export async function claudeTuiSettingsArgs(
  platform: Pick<SessionpagePlatformModel, 'settingsDocumentPath'>,
  sessionArgs: readonly string[],
): Promise<string[]> {
  if (platform.settingsDocumentPath) return []
  if (sessionArgs.includes('--settings')) return []
  return ['--settings', await claudeTuiBaseSettingsFile()]
}

/**
 * 开机收尸:删掉上一次没能走到 release 就死掉的进程留下的覆盖文件。
 *
 * 文件里有那次会话的中转令牌。令牌本身在网关侧带硬过期(续期靠活着的进程驱动,进程死了就不再续),
 * 所以残留窗口最多一个 TTL —— 但 0600 只挡得住别的用户,挡不住同一账号下的其它程序,没有理由把它
 * 留到自然过期。❌ 不按时间粗暴清扫:同机可能有另一个咕咕实例正在用它自己的文件。判据是写文件的
 * 那个 pid 还在不在。
 */
export async function sweepStalePlatformSettingsFiles(): Promise<void> {
  const keep = persistedRelayFiles()
  let entries: string[]
  try {
    entries = await readdir(tmpdir())
  } catch (error) {
    log.error({ err: error }, '扫描残留 platform settings 文件失败')
    return
  }
  for (const name of entries) {
    const isSettings = name.startsWith(SETTINGS_FILE_PREFIX) && name.endsWith('.json')
    // `.token` 是更早的构建落盘的网关令牌(这一版不再写),照样按 pid 收掉。
    const isCredential = name.startsWith(CREDENTIAL_FILE_PREFIX)
      && ['.curlrc', '.sh', '.cmd', '.token'].some((suffix) => name.endsWith(suffix))
    if (!isSettings && !isCredential) continue
    // #6264 写它的宿主已经不在,但那条会话还在 tmux 里用它、下一个宿主要认回来:不收。
    if (keep.has(join(tmpdir(), name))) continue
    const prefix = isSettings ? SETTINGS_FILE_PREFIX : CREDENTIAL_FILE_PREFIX
    const owner = Number(name.slice(prefix.length).split('-')[0])
    // 认不出 pid 的 = 旧命名(会话 id 哈希)留下的残留,那种名字这一版再也不会写出来,直接收掉。
    if (Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) continue
    await rm(join(tmpdir(), name), { force: true }).catch((error: unknown) => {
      log.error({ file: name, err: error }, '删除残留 platform settings 文件失败')
    })
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在,只是不归我们管 —— 也算活着,别删它的文件。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 续期发起时机 = 剩余寿命过半。
 *
 * 不用固定周期,是因为 TTL 归服务端管(MODEL_SESSION_TTL_SECONDS,运营可调),客户端写死一个数字
 * 就会在服务端调短 TTL 之后集体踩线。按剩余寿命折半:第一次在 T/2,失败后下一次在剩余的一半,
 * 越接近到期重试越密 —— 一次网络抖动不会直接判会话死刑,而重试次数天然有界。
 *
 * 低于这个下限就不再试:剩下的时间已经不够一个来回,继续试只会在日志里刷,不如响亮认输、
 * 让 token 自然过期由结算巡检收尾。
 */
const RENEWAL_FLOOR_MS = 30_000

/**
 * 谁在驱动续期:**宿主对这个 conversation 的存活判断**,不是一个盲跑的定时器。
 * 记录只在 platformModelForSession 里建立、在 releasePlatformModelForSession 里删除,
 * 而后者由会话页后端的 pty teardown 调用 —— 会话结束/进程死亡/用户退出,续期随之立刻停止。
 */
function scheduleRenewal(sessionId: string, expiresAt: string): void {
  const held = activeAccessSessions.get(sessionId)
  if (!held) return
  if (held.renewTimer) clearTimeout(held.renewTimer)
  if (Date.now() >= held.renewUntil) {
    log.error({ sessionId, renewUntil: held.renewUntil }, '平台模型令牌达到续期寿命上限，停止盲续；下一次真实请求时重新签发，没人用则自然过期由 reconciler 结算')
    return
  }
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(remaining) || remaining <= RENEWAL_FLOOR_MS) {
    log.error({ sessionId, expiresAt, remaining }, '平台模型令牌已来不及续期，会话将因凭据过期失败')
    return
  }
  const timer = setTimeout(() => {
    void renewOnce(sessionId, expiresAt)
  }, Math.floor(remaining / 2))
  // 不要因为一个续期定时器吊住主进程的退出。
  timer.unref?.()
  held.renewTimer = timer
}

async function renewOnce(sessionId: string, previousExpiresAt: string): Promise<void> {
  const held = activeAccessSessions.get(sessionId)
  // 会话在等待期间结束了 —— 什么都不做。这正是「只在会话真的活着时续」。
  if (!held || held.launch.expiresAt !== previousExpiresAt) return
  // 定时器按 token 剩余寿命排,最后一发可能恰好落在绝对上限之后。schedule 时的检查不能代替
  // 调用前检查,否则上限外仍会多续一次,把凭据寿命再向后推一个完整 TTL。
  if (Date.now() >= held.renewUntil) {
    log.error({ sessionId, renewUntil: held.renewUntil }, '平台模型令牌达到续期寿命上限，停止盲续；下一次真实请求时重新签发，没人用则自然过期由 reconciler 结算')
    return
  }
  if (platformModelIsExpired(held.launch)) {
    log.error({ sessionId, accessSessionId: held.accessSessionId, expiresAt: previousExpiresAt }, '平台模型令牌已过期，等待宿主恢复协调器重新签发')
    return
  }
  const accessSessionId = held.accessSessionId
  try {
    const renewed = await renewPlatformModelAccess(held.authProvider, accessSessionId)
    if (activeAccessSessions.get(sessionId) !== held || held.accessSessionId !== accessSessionId) return
    held.launch = { ...held.launch, expiresAt: renewed.expiresAt }
    // 认回的会话手里还没有令牌:续期只推有效期,令牌仍要在第一次要票时重签(见 restorePlatformRelaySessions)。
    if (held.token) held.renewalFailedAt = undefined
    noteMembershipLocked(sessionId, held, renewed.membershipLocked)
    persistRelaySession(sessionId)
    held.observationSink?.({
      generation: accessSessionId,
      source: 'lease',
      observedAt: new Date().toISOString(),
      leaseExpiresAt: renewed.expiresAt,
      operation: 'renew',
      outcome: 'success',
      classification: 'lease-renewed',
    })
    log.info({ sessionId, accessSessionId: held.accessSessionId, expiresAt: renewed.expiresAt }, '平台模型令牌续期成功')
    scheduleRenewal(sessionId, renewed.expiresAt)
  } catch (error) {
    if (activeAccessSessions.get(sessionId) !== held || held.accessSessionId !== accessSessionId) return
    // Claude has a live helper path. A blind timer retry only hides the failure and can leave
    // the next request carrying a token whose gateway expiry is unknown; mark it so the helper
    // asks the main process for a replacement before Claude sends the request.
    held.renewalFailedAt = Date.now()
    log.error(
      { sessionId, accessSessionId: held.accessSessionId, expiresAt: previousExpiresAt, err: error },
      '平台模型令牌续期失败',
    )
    held.observationSink?.({
      generation: accessSessionId,
      source: 'lease',
      observedAt: new Date().toISOString(),
      leaseExpiresAt: previousExpiresAt,
      operation: 'renew',
      outcome: 'failure',
      classification: error instanceof Error ? error.message : String(error),
    })
    if (held.credentialRoute) {
      log.error({ sessionId, accessSessionId: held.accessSessionId }, 'harness 将在下一次 credential helper/relay 请求时重新签发平台令牌')
      return
    }
    // Other harnesses still receive credentials in their child process at spawn time and
    // cannot consume a replacement in place. Keep their bounded retry/reopen contract.
    scheduleRenewal(sessionId, previousExpiresAt)
  }
}

/** Rotate the lease behind a live process; its helper/loopback relay consumes the replacement. */
async function rotatePlatformLease(sessionId: string): Promise<boolean> {
  const held = activeAccessSessions.get(sessionId)
  if (
    !held
    || !held.credentialRoute
    || !held.agentUserId
    || !held.modelId
    || !held.protocol
  ) return false
  if (held.rotationPromise) return held.rotationPromise
  const agentUserId = held.agentUserId
  const modelId = held.modelId
  const protocol = held.protocol
  const claudeHelperSession = Boolean(held.credentialConfigPath)

  const pending = (async () => {
    // ❌ 这里不看盲续上限:rotate 只由真实使用触发(取票脚本 / 回环中转的请求、恢复闸的 ensureReady),
    // 走的是完整签发路径,服务端照常查登录、额度与模型上架 —— 见 MAX_RENEWED_LIFETIME_MS。
    const replacement = await issuePlatformModelAccess({
      authProvider: held.authProvider,
      agentUserId,
      engineId: held.providerId,
      modelId,
      protocol,
      providerSessionId: null,
      sessionId,
      // harness 进程还是原来那个,它的可切清单是启动时那份 —— 新票继承旧票记下的那一份。
      keepFromAccessSessionId: held.accessSessionId,
    })
    // The session may have been released while issue() was in flight. Do not commit a replacement
    // for a generation that teardown already removed; otherwise the new server lease would outlive
    // the conversation that owned it. (The replacement token lives only in memory — nothing to delete.)
    if (activeAccessSessions.get(sessionId) !== held) {
      await revokePlatformModelAccess(held.authProvider, replacement.accessSessionId).catch((error: unknown) => {
        log.error(
          { sessionId, accessSessionId: replacement.accessSessionId, err: error },
          '已结束会话的 replacement session 撤销失败',
        )
      })
      return false
    }

    const previousAccessSessionId = held.accessSessionId
    const platformProvider = claudeHelperSession
      ? {
        baseUrl: `${replacement.relayUrl.replace(/\/$/, '')}/v1`,
        apiKey: replacement.token,
      }
      : held.launch.platformProvider
    held.accessSessionId = replacement.accessSessionId
    held.token = replacement.token
    held.relayUrl = replacement.relayUrl
    noteMembershipLocked(sessionId, held, replacement.membershipLocked)
    held.launch = {
      ...held.launch,
      accessSessionId: replacement.accessSessionId,
      expiresAt: replacement.expiresAt,
      model: replacement.model,
      platformProvider,
      modelCapability: held.launch.modelCapability
        ? {
          ...held.launch.modelCapability,
          ...(platformProvider ? { platformProvider } : {}),
        }
        : null,
    }
    if (replacement.modelId) held.modelId = replacement.modelId
    held.renewalFailedAt = undefined
    issueBackoffs.delete(sessionId)
    // 一次完整签发 = 一条新链:盲续上限从这一刻重新起算。
    held.renewUntil = Date.now() + renewedLifetimeMs()
    persistRelaySession(sessionId)
    held.observationSink?.({
      generation: replacement.accessSessionId,
      source: 'lease',
      observedAt: new Date().toISOString(),
      leaseExpiresAt: replacement.expiresAt,
      operation: 'issue',
      outcome: 'success',
      classification: 'lease-reissued',
    })
    await revokePlatformModelAccess(held.authProvider, previousAccessSessionId).catch((error: unknown) => {
      log.error({ sessionId, accessSessionId: previousAccessSessionId, err: error }, '平台模型旧会话撤销失败')
    })
    log.info(
      { sessionId, previousAccessSessionId, accessSessionId: replacement.accessSessionId, expiresAt: replacement.expiresAt },
      '平台模型凭据已重新签发，运行中的 harness 将继续使用原进程',
    )
    scheduleRenewal(sessionId, replacement.expiresAt)
    return true
  })()
  held.rotationPromise = pending
  try {
    return await pending
  } finally {
    const current = activeAccessSessions.get(sessionId)
    if (current?.rotationPromise === pending) current.rotationPromise = undefined
  }
}

/** Reissue an expired lease after host resume while keeping the live inference owner. */
async function reissueExpiredRuntimeLease(sessionId: string): Promise<boolean> {
  const held = activeAccessSessions.get(sessionId)
  if (!held || !platformModelIsExpired(held.launch)) return false
  return rotatePlatformLease(sessionId)
}

/**
 * What a session-page session needs in order to run on platform quota: where to send the
 * requests, and which model the quota designates.
 *
 * `model` is not decoration. The token minted for this session is restricted at the
 * gateway to exactly one New API model, so a session that is pointed at the relay but
 * left on the harness's own default model does not quietly run on the wrong model —
 * it is rejected outright and the agent never starts. Handing the relay over without
 * the model is therefore not a partial success, it is a broken session.
 */
export interface SessionpagePlatformModel {
  /** Non-secret model-access generation used to make teardown compare-and-release. */
  accessSessionId: string | null
  /** Server wall-clock expiry for this generation; null when the session is not on platform quota. */
  expiresAt: string | null
  /** Provider env for this session; empty when the session is not on platform quota. */
  env: Record<string, string>
  /**
   * The model this session's quota designates, or null when not on platform quota.
   *
   * Providers that start their own inference process must be BUILT with this — handing it
   * to the pty afterwards pins the terminal the user watches and nothing else.
   */
  model: string | null
  /**
   * Environment that pins the model for providers configured that way.
   *
   * ❌ Still no general `extraArgs` counterpart: codex's argv belongs to its app-server and is
   * rebuilt there from `model` + `platformProvider` + `contextWindow`, so publishing it here
   * would invite appending it to the TUI client, which pins nothing. `clientArgs` below is the
   * visible-client exception (filtered by dialect); `adapterArgs` is the ACP-adapter exception
   * (ACP surface only, read only by the adapter-env envelope). Neither is that general channel.
   *
   * ⚠️ That rebuild is why every part of the model declaration must be published here
   * individually. `contextWindow` was computed into `materializeModelCapability`'s `extraArgs`
   * and then dropped on the floor with them — the app-server rebuilt its argv from the two
   * fields this interface did publish and emitted no `model_context_window` at all, so every
   * codex platform session ran on the harness's own default window. Adding a field to the model
   * declaration means adding it here too.
   */
  spawnEnv: Record<string, string>
  /**
   * argv that must go on the **visible pty's own** command line, because for this harness that
   * process is the one talking to the model.
   *
   * This carries claude's `--settings`, which is the only layer that outranks a user's
   * `~/.claude/settings.json` `env` block — and that block wins over the process environment, so
   * `env` above is not enough on its own (real-machine finding: a user's own ANTHROPIC_BASE_URL
   * took a platform-billed session to their gateway while the UI said Gugu). Codex remote TUI is
   * the narrow second case: it receives only the secret-free custom-provider declaration needed
   * to pass its startup auth gate; its model still belongs exclusively to the app-server argv.
   */
  clientArgs: string[]
  /**
   * argv the dialect materializer produced for an **ACP adapter process that is the harness itself**
   * (the `adapter-env` envelope: copilot's startup `--effort`, #6218). Empty on the TUI surface —
   * that leg's own command builder already puts the same flag on the pty. Only the adapter-env
   * envelope reads it; codex's `-c` flags can land here on the ACP surface, but its envelope
   * (`adapter-spawn`) rebuilds its argv from the published fields above and never reads this.
   */
  adapterArgs: string[]
  /**
   * 这次会话那份 0600 settings 文档的**路径**,不走平台额度(或这个 harness 不需要文档)时为 null。
   *
   * 与 `clientArgs` 是同一份文件的两种去处,分开发布是因为去处由界面决定:终端会话把它挂进
   * `clientArgs`(`--settings <路径>`),Chat UI 把它放进 ACP 的 `_meta` 交给适配器 —— 那条路上
   * `--settings` 是个适配器不认识的参数,而真正读设置的是它背后自己 spawn 的那个 claude 进程。
   *
   * 发布**路径**而不是文档内容:文档里有这次会话的中转令牌,内联进任何一条命令行都等于写进进程表。
   */
  settingsDocumentPath: string | null
  /**
   * Relay endpoint and session key, for harnesses that must be told where to send requests
   * as part of their model declaration.
   *
   * Codex needs this: it ignores OPENAI_BASE_URL (verified against codex-cli 0.144.6, which
   * went to api.openai.com and returned 401), so pointing it at the relay requires a declared
   * provider rather than provider environment variables.
   */
  platformProvider: { baseUrl: string; apiKey: string } | null
  /**
   * This platform model's real context window in tokens, or null when it is unknown or the
   * session is not on platform quota.
   *
   * Published alongside `platformProvider` because it belongs to the same declaration: a harness
   * that rebuilds its own model argv needs the window as much as it needs the endpoint. Only the
   * dialects that take the window as argv/config read it — the anthropic surface already carries
   * it inside `env` (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), which is why that path was never broken.
   *
   * Null = unknown → the consumer emits nothing and the harness keeps its own default. ❌ Never
   * substitute a guess: too large turns "compacts early" into "overflows the gateway".
   */
  contextWindow: number | null
  /**
   * This platform model's accepted reasoning levels (`billing.platform_models.reasoning_efforts`, #6447),
   * or null when the directory has none / the session is not on platform quota. Same declaration as
   * `contextWindow`, published for the same reason: codex's catalog declares it per model.
   */
  reasoningEfforts: readonly string[] | null
  /**
   * 这次会话的**模型声明本体**(端点、令牌、模型 id、窗口、会话配置中的推理档),不上平台时为 null。
   *
   * 给「模型这一维由这一家自己的物化器投递」的那些腿用:宿主不再把它拍扁成环境变量,而是把
   * 整份声明交给 session bundle,由物化器写进这一家的配置文件 —— 那是唯一能同时带上模型
   * **能力声明**(kimi 的 `support_efforts`)的载体。
   *
   * ⚠️ 上面那几个字段是这份声明拍扁后的**投影**,留着是因为各家消费的形状不同;
   *    ❌ 别把它们当成两份真值 —— 都从这一份来。
   */
  modelCapability: SessionModelCapability | null
  /**
   * 这条会话中途可以**热切**到的模型(这条协议下上架的全部平台模型,服务端随令牌算出、原样带下来),
   * 不上平台时为空。永远包含当前这个模型。
   *
   * 与 `modelCapability.platformModels` 是同一份 —— 单独发布是因为 ACP 那条信封
   * (`AcpPlatformInjection`)是手工组装的扁平载荷,拿不到整份声明(见 codexPlatformInjection 抬头:
   * 「字段加在这里还不够,schema 必须同时声明它」)。
   */
  switchableModels: readonly PlatformSwitchableModel[]
}

/** One entry of the switchable set: each model carries its OWN window and reasoning levels. */
type PlatformSwitchableModel = {
  id: string
  displayName: string
  contextWindow: number | null
  reasoningEfforts: readonly string[] | null
}

/**
 * Graft this session's platform declaration onto the model capability a harness will be BUILT from
 * — the **pty / app-server** surface.
 *
 * Exported, and a function rather than an object spread written at the call site, because the
 * defect it exists to prevent is exactly a call site that grafts some of the declaration and
 * forgets the rest. It lived inline in `main.ts`, which no test can reach: it carried
 * `platformProvider` and dropped `contextWindow`, so every codex platform session was built against
 * the harness's own default window while the catalog held the real one, with nothing failing and
 * nothing logged.
 *
 * The ACP surface takes the same declaration in a different envelope; it has its own function
 * ({@link codexPlatformInjection}) for the same reason. Two surfaces, two functions, two tests —
 * ❌ no inline graft left on either.
 *
 * Not on platform quota (no provider) → the capability is returned untouched: a BYOK session points
 * the harness at the vendor under the model's own name, which it already knows the window for.
 */
export function withPlatformDeclaration<T extends SessionModelCapability>(
  model: T,
  platform: Pick<SessionpagePlatformModel, 'platformProvider' | 'contextWindow'>
    & Partial<Pick<SessionpagePlatformModel, 'modelCapability' | 'switchableModels' | 'reasoningEfforts'>>,
): T & Pick<SessionModelCapability, 'platformProvider' | 'contextWindow' | 'platformSettingsEnv' | 'platformModels' | 'reasoningEfforts' | 'platformCallableRoutes'> {
  if (!platform.platformProvider) return model
  const platformSettingsEnv = platform.modelCapability?.platformSettingsEnv
  const platformCallableRoutes = platform.modelCapability?.platformCallableRoutes
  return {
    ...model,
    platformProvider: platform.platformProvider,
    // 这条会话能热切到的整组平台模型 —— codex 的 model catalog 按它逐条声明(#5635)。
    // 空集合(旧版 edge function)⇒ 不加键,物化器只声明当前这一个。
    ...(platform.switchableModels?.length ? { platformModels: platform.switchableModels } : {}),
    // 协议表原话是同一份声明的第三格(gemini 的中转两键只从它拿,#4700)—— 嫁接时一并带上,
    // 否则就是本函数抬头说的那种「嫁接了一半」。没有(OpenAI 面方言)就不加键。
    ...(platformSettingsEnv ? { platformSettingsEnv } : {}),
    // ❌ 不用裸真值判断。窗口的「值得一说」谓词只有一个定义 —— capability-bundle 的 positiveWindow
    // (safe integer 且 > 0)。裸真值会把 -1 / 1000.5 / Infinity 判成「有值」发出去,而下游
    // acpPlatformInjectionSchema 要求 int().positive() 会当场抛 —— 于是「一个该被忽略的坏数」
    // 变成「这条会话开不起来」,恰好违背本字段自己写的契约(未知 → 不发,harness 保留默认)。
    ...(positiveWindow(platform.contextWindow) ? { contextWindow: platform.contextWindow } : {}),
    // 推理档与窗口同一份声明(#6447):codex 的 catalog 按它给这个模型声明档位。目录没有 ⇒ 不加键。
    ...(platform.reasoningEfforts ? { reasoningEfforts: platform.reasoningEfforts } : {}),
    // 令牌能调的路由(#6921)同一份声明:codex 的物化器据此开不开出图工具。服务端没报 ⇒ 不加键。
    ...(platformCallableRoutes ? { platformCallableRoutes } : {}),
  }
}

/**
 * 这条会话的 bundle 该不该带模型声明 —— 只有「模型走自己配置文件」的那些腿才带。
 *
 * 单独成函数、而不是在两个 spawn 钩子里各写一遍三元表达式,理由与
 * {@link withPlatformDeclaration} 一模一样:那两处是 main.ts 里的**内联字面量**,
 * 没有任何测试够得到 —— 而这正是本次缺陷的形状(descriptor 说模型走配置文件,
 * 两条腿的 bootstrap 却都不传 `bundle.model`,那张表从没被写过,两边都不报错)。
 *
 * ❌ 别改成无条件返回 `platform.modelCapability`:`process-config` 的家宿主仍在按方言
 *    发模型键,再给一份 bundle.model 就是同一维两条路,而两条路都「成功」、都不报错。
 */
export function sessionBundleModelFor(
  providerId: string,
  surface: HarnessSessionSurface,
  platform: Pick<SessionpagePlatformModel, 'modelCapability'> | null,
): SessionModelCapability | null {
  if (!providerDeliversModelViaConfigFile(providerId, surface)) return null
  return platform?.modelCapability ?? null
}

/**
 * 同一份平台声明，ACP 那个信封 —— 适配器从这个载荷重建 codex 的 config。
 *
 * 单独成函数、且与 {@link withPlatformDeclaration} 并排放，理由一模一样：这段原本是 main.ts 里的
 * 内联对象字面量，没有任何测试够得到它，而「嫁接了一半」正是本次缺陷的形状。两个界面各自一个函数、
 * 各自一条测试，才不会下次又只补一边。
 *
 * ⚠️ 字段加在这里还不够：`acpPlatformInjectionSchema` 必须同时声明它。zod 默认丢弃未声明的键，
 * 不报错也不记日志 —— 声明漏了，下游读到的就是 undefined，且没有任何东西会提醒你。
 */
export function codexPlatformInjection(input: {
  model: string
  providerId: string
  providerLabel: string
  baseUrl: string
  apiKey: string
  // 用它真正的类型,❌ 不退化成 Record<string, unknown>:那样既丢掉字段校验,又要在调用点补一次
  // 展开去迎合索引签名 —— 而「为了过类型而展开」正是让上一处漏字段没被编译器发现的原因。
  authRequest: CodexPlatformAuthRequest
  spawnEnv: Record<string, string>
  contextWindow: number | null
  /** 这个模型认的推理档(目录逐模型下发,#6447);null = 目录没有。 */
  reasoningEfforts: readonly string[] | null
  /** 这条会话可热切到的整组模型(与令牌白名单同一份);空 = 只有 `model` 一个。 */
  switchableModels: readonly PlatformSwitchableModel[]
  /**
   * 签发响应的 `callable_routes`(#6921);undefined / 空 = 老服务端 = 没有。
   * 键必填(值可 undefined):调用点漏传它时让编译器报,❌ 静默变成「聊天腿永远不能出图」。
   */
  callableRoutes: PlatformCallableRoutes | undefined
}): AcpPlatformInjection {
  return {
    model: input.model,
    providerId: input.providerId,
    providerLabel: input.providerLabel,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    authRequest: { ...input.authRequest },
    spawnEnv: input.spawnEnv,
    // 与 pty 那侧同一个谓词。❌ 别在这里另写一遍判断：窗口「值不值得一说」只该有一个定义。
    ...(positiveWindow(input.contextWindow) ? { contextWindow: input.contextWindow } : {}),
    ...(input.reasoningEfforts ? { reasoningEfforts: [...input.reasoningEfforts] } : {}),
    // ❌ 别在这里省掉它:适配器的模型清单就是从这一项来的,漏了这一格 codex 的会话里
    // 就只剩 codex 自家那 7 个内建模型,而当前这个咕咕模型连回都回不去(实测的那道单向门)。
    ...(input.switchableModels.length > 0
      ? {
        switchableModels: input.switchableModels.map((entry) => ({
          id: entry.id,
          displayName: entry.displayName,
          ...(positiveWindow(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {}),
          ...(entry.reasoningEfforts ? { reasoningEfforts: [...entry.reasoningEfforts] } : {}),
        })),
      }
      : {}),
    // ❌ 别在这里省掉它:ACP 腿的出图开关只从这一项来(#6921),漏了就是「终端腿能出图、聊天腿不能」。
    ...(input.callableRoutes && Object.keys(input.callableRoutes).length > 0
      ? {
        callableRoutes: Object.fromEntries(
          Object.entries(input.callableRoutes).map(([route, models]) => [route, [...models]]),
        ),
      }
      : {}),
  }
}

const NOT_ON_PLATFORM: SessionpagePlatformModel = {
  accessSessionId: null,
  expiresAt: null,
  env: {}, model: null, spawnEnv: {}, clientArgs: [], adapterArgs: [], settingsDocumentPath: null, platformProvider: null,
  contextWindow: null, reasoningEfforts: null, modelCapability: null, switchableModels: [],
}

/**
 * 这条会话上不了咕咕额度时,抛给启动路径的那一句。它会一路落到会话失败那一行 / 私聊横幅 / 另一台机器的新建框里,
 * 所以**只报原因码**(各端按界面语言说,#7103「谁拒绝谁说话」);服务端原文与这里写给开发者的话只进日志。
 * 认不出的一律 `service-unavailable`(「咕咕这边出错了」)。已经带码的(本机认得出的原因)原样往上递。
 * ❌ 这里不吞:失败仍是失败(见下面 platformModelForSession 的抬头)。
 */
export function platformAccessStartError(error: unknown, context: { sessionId: string; providerId: string }): Error {
  const thrown = error instanceof Error && guguReasonInText(error.message)
    ? error
    : new Error(guguCatalogReasonCode(modelAccessFailureReason(error)), { cause: error })
  // 日志器只记 Error 自己的 message/stack,❌ 带 cause:写给开发者的那句在 cause 里,单独记。
  log.warn(
    { ...context, reason: thrown.message, err: error, cause: error instanceof Error ? error.cause : undefined },
    'platform access could not be issued for this session',
  )
  return thrown
}

/** 本机认得出、有话可说的拒绝:界面只拿到原因码,写给开发者的那句挂在 cause 上进日志。 */
function platformRefusal(reason: Parameters<typeof guguCatalogReasonCode>[0], detail: string): Error {
  return new Error(guguCatalogReasonCode(reason), { cause: new Error(detail) })
}

type PlatformModelForSessionInput = {
  /** Runtime owner for token lifetime. Runtime-only views use their view id here. */
  sessionId: string
  /** Persisted conversation used only to resolve the Gugu identity. */
  identitySessionId?: string
  providerId: string
  authProvider: RuntimeAuthProvider | null
  env?: NodeJS.ProcessEnv
  /**
   * @@@2503 What the composer decided for THIS session — the session's only decision point.
   *
   * `{ modelId }` 选了平台模型 → 这次会话上平台 relay,用的就是这个模型。
   * `null`       选了 harness 自家模型 → 纯 BYOK,**一个平台环境变量都不注入**,即使这个会话的 agent
   *              级 `model_access` 配着平台模型也一样(agent 级配置已退位为下拉的预选默认值)。
   * `undefined`  这个决定出现之前建的存量会话,没有 per-session 记录 → 回退按 agent 级 `model_access`
   *              解析,也就是这些会话一直以来的行为。兼容期一过、存量会话消化完,这条回退就没有输入了。
   */
  platformModel?: { modelId: string } | null
  /**
   * Provision-or-resolve this conversation's gugu agent identity, for the case where it does not
   * have one yet.
   *
   * A brand-new session is provisioned INSIDE the provider hook, which runs after this function —
   * so on a first spawn the roster lookup below finds nothing. That was harmless while the platform
   * decision came from the agent (a brand-new agent has no `model_access` anyway), but the composer's
   * pick has to hold on the very first turn: without an identity the platform token cannot be minted
   * at all, and the session would silently run BYOK while the composer says otherwise. Idempotent —
   * the hook's own provisioning call afterwards resolves the same identity.
   */
  ensureAgentUserId?: () => Promise<string | null>
  /**
   * #5331 身份可能只是本机那层(公网那一发还在后台跑)。签平台令牌要的是云端那一行(服务端按 agent_user_id 校验归属),
   * 所以签之前等它落地。缺席 ⇒ 不等(老的同步链上身份一定已经在云端)。
   */
  awaitCloudIdentity?: (agentUserId: string) => Promise<void>
  /**
   * 这条会话跑在哪个界面上 —— 终端会话(pty)还是 Chat UI(ACP)。
   *
   * 必填,没有默认值:同一个引擎在两个界面上的注入拓扑不是一回事(凭据落到哪个进程、令牌绑谁的
   * 存活、settings 文档挂 argv 还是进 `_meta`)。给个默认值等于替调用方猜拓扑,而猜错的后果正是
   * 这套契约要防的那件事:注入看起来做了,实际一个字节都没到达真正跟模型说话的那个进程。
   */
  surface: InjectionSurface
  /** Host observation sink; runtime facts stay out of static descriptors. */
  onCredentialObservation?: (observation: PlatformCredentialRuntimeObservation) => void
}

/**
 * Platform relay + designated model for this session-page session, or "not on platform
 * quota" when the session was never eligible.
 *
 * Returns the not-on-platform value — "leave the session's existing setup alone" — only when
 * the session was never eligible for platform quota in the first place: nobody is signed in,
 * the composer picked one of the harness's own models, the conversation is not a gugu agent,
 * or that agent has no platform access.
 *
 * @@@throws-on-gateway-failure — a REACHABILITY failure is NOT one of those cases. If the control
 * plane is unreachable or rejects us, this throws and the session does not start. That is the
 * contract in product spec: 网关不可用时 fail loud，不得回退到用户 Key，也不得改用另一个
 * 平台模型。❌ Do not wrap `resolveAgentModelLaunch` in a try/catch to "keep the session running" —
 * returning the not-on-platform value there would silently hand the turn to whatever key happens
 * to be in the environment, which is exactly the fallback the spec forbids.
 */
export async function platformModelForSession(input: PlatformModelForSessionInput): Promise<SessionpagePlatformModel> {
  // 这条会话上不了咕咕额度的一切原因都在这一处变成原因码(#7103):往上递的只有码,原文进日志。
  const platform = await resolvePlatformModelForSession(input).catch((error: unknown) => {
    throw platformAccessStartError(error, { sessionId: input.sessionId, providerId: input.providerId })
  })
  // #6334 用量页按这一笔把 Token 分成「咕咕模型 / 自己账号」:计费路就在这里定下来。
  // 抛了(网关不可达等)= 会话没起来,不记。
  recordModelSource(input.sessionId, platform.model ? 'gugu' : 'byok')
  return platform
}

async function resolvePlatformModelForSession(input: PlatformModelForSessionInput): Promise<SessionpagePlatformModel> {
  const env = input.env ?? process.env
  // 选了 harness 自家模型 = 这次会话不上平台。在问 agent 之前就返回:agent 级配置在这条路上已经
  // 没有发言权,读了它反而给了「即使选了 harness 也可能被盖成平台」的可乘之机。
  if (input.platformModel === null) return NOT_ON_PLATFORM
  // 选了平台模型却没有运行时连接 = 拿不到平台额度。这时候**不能**返回「不上平台」——那等于把这一轮
  // 交给环境里恰好存在的用户 Key 去跑,而 composer 上写着咕咕的模型。product spec 要的是响亮失败。
  if (!input.authProvider) {
    if (input.platformModel) {
      throw platformRefusal('runtime-not-connected', 'agent runtime auth provider is not connected; cannot issue platform quota for this session')
    }
    return NOT_ON_PLATFORM
  }
  const selection = input.platformModel
    ? perSessionSelection(input.platformModel.modelId, input.providerId)
    : undefined
  if (input.platformModel?.modelId) {
    await assertUserModelAllowed(env, input.providerId, input.platformModel.modelId)
  }

  // #4277 按当下账号找这条会话的 agent:活动行归别家 ⇒ 视为还没有身份,交给 ensureAgentUserId
  // (provisioning 会停放别家的行、给当前账号登记),❌ 拿别家的 agent 去签额度(RLS 必拒)。
  const currentOwnerUserId = (await input.authProvider.getAuth())?.userId ?? null
  const agentUserId = await guguAgentUserIdForSession(
    input.identitySessionId ?? input.sessionId,
    env,
    currentOwnerUserId,
  )
    ?? (selection ? await input.ensureAgentUserId?.() ?? null : null)
  if (!agentUserId) {
    // 同上:身份签不出来(这个 provider 不注册咕咕身份、或 provisioning 失败)时,选了平台模型的会话
    // 必须停下。悄悄跑 BYOK 是「界面说 A、实际跑 B」,而且用户的 Key 在他不知情时被花掉了。
    if (selection) {
      throw platformRefusal(
        input.surface === 'cui' ? 'no-identity-chat' : 'no-identity-terminal',
        `session has no gugu identity (${input.providerId} registers none); cannot issue platform quota`,
      )
    }
    return NOT_ON_PLATFORM
  }

  // @@@5331 平台令牌要拿公网身份行才签得出来 —— 会话启动本身不等它,但走到签令牌
  // 这一步必须等它落地(内网身份即刻、公网身份后台落地,见 #5323)。
  await input.awaitCloudIdentity?.(agentUserId)

  // The creation composer persists its selected effort in the conversation config. Read that
  // record here, at the shared platform injection boundary, so every surface uses the same value.
  // Runtime-only views have no conversation row of their own and must resolve from their source.
  const identitySessionId = input.identitySessionId ?? input.sessionId
  // 武装哪一档要等签发之后才定:要看**这个模型**在目录里认哪些档(#6447),见下面 platformArmedEffort。
  const recordedEffort = (await getSessions())
    .find((session) => session.id === identitySessionId)
    ?.effort?.trim() || null

  // @@@2503 先释放旧的,再签新的。反过来会自锁:同一条会话重启时,签发那一刻旧会话仍然 live 并
  // 持有它那份预留,而额度窗口是把在途预留扣掉之后算的 —— 一条会话因此会被自己上一轮挡在门外。
  // 释放是幂等的(没有记录就直接返回),所以首次启动走这里也没有额外代价。
  await releasePlatformModelForSession(input.sessionId)

  // 与取票同一个退避判断:这条会话刚签失败过、还在窗口里 ⇒ 重建当场给同一个原因,❌ 再打控制面 ——
  // 收件箱 / agent.deliver / 直投会在会话没在跑时自动唤醒它,签发一直失败时每次触发都会走到这里。
  // 人点的出口(起任务页与私聊横幅的重试、恢复重试、「我开好了」)先 clearPlatformIssueBackoff 再来,真去问一次(#7103)。
  const backoff = activeIssueBackoff(input.sessionId, agentUserId, input.platformModel?.modelId ?? null)
  if (backoff) throw backoff.error.cause
  const launch = await resolveAgentModelLaunch({
    authProvider: input.authProvider,
    env,
    agentUserId,
    engineId: input.providerId,
    providerSessionId: null,
    sessionId: input.sessionId,
    // undefined = 存量会话,读 agent 级 model_access(见上面 platformModel 的兼容说明)。
    selection,
  }).catch((error: unknown) => {
    recordIssueFailure(input.sessionId, agentUserId, input.platformModel?.modelId ?? null, error)
    throw error
  })
  issueBackoffs.delete(input.sessionId)
  if (!launch.access) return NOT_ON_PLATFORM

  // 起始推理档 = 记录里那一档 ∩ 该模型在目录里认的档 ∩ 这家引擎的词表(与 composer 能选的档同一个交集)。
  // 不在交集里的(旧存档、换模型留下的旧档)不武装、harness 用默认 —— 原样交给 OpenCode 家族的物化器会抛错,
  // 会话就开不起来。
  const effortCapability = pluginRegistry.get(input.providerId)?.capabilities.effort
  const configuredEffort = platformArmedEffort(
    recordedEffort,
    launch.access.reasoningEfforts,
    effortCapability?.kind === 'selectable' ? Object.keys(effortCapability.effortOptions) : null,
  )
  if (recordedEffort && configuredEffort === null) {
    log.info({
      sessionId: input.sessionId,
      providerId: input.providerId,
      model: launch.access.model,
      recordedEffort,
      modelEfforts: launch.access.reasoningEfforts,
    }, 'platform launch: recorded reasoning level is not one this model and harness both accept; not arming it')
  }

  const dialect = injectionDialectForEngine(input.providerId)

  if (dialect && MODEL_CONFIG_DIALECT.requiresContextWindow.has(dialect)
    && !positiveWindow(launch.access.contextWindow)) {
    throw new Error(
      `${input.providerId} platform model '${launch.access.model}' requires a positive contextWindow for limit.context`,
    )
  }

  // 这家**怎么接收模型指定** = 它声明的方言。在记录令牌之前解析,钉不住模型的引擎就死在这里,
  // 而不是等到已经开始花额度之后。
  //
  // 方言真值原由已退役的引擎表提供；现随插件代码编译。
  const modelGoesToConfigFile = providerDeliversModelViaConfigFile(
    input.providerId,
    input.surface === 'tui' ? 'tui' : 'acp',
  )
  const credentialLifecycle = resolveSessionpageCredentialLifecycle(
    input.providerId,
    input.surface === 'tui' ? 'tui' : 'acp',
  )
  const usesCredentialProxy = credentialLifecycle?.delivery === 'credential-proxy'
  const credentialProxyRoute = usesCredentialProxy ? randomUUID() : null
  const credentialProxyEndpoint = usesCredentialProxy ? await ensureCredentialEndpoint() : null
  const platformProvider = credentialProxyRoute && credentialProxyEndpoint
    ? {
      baseUrl: `${credentialProxyEndpoint.baseUrl}/gugu-platform-relay/${credentialProxyRoute}/v1`,
      apiKey: credentialProxyEndpoint.secret,
    }
    : {
      baseUrl: `${launch.access.relayUrl.replace(/\/$/, '')}/v1`,
      apiKey: launch.access.token,
    }
  // 这条会话**中途还能换到**哪些模型 —— 服务端随令牌一起算出来的那一组(这条协议下的全部平台模型)。
  // 三家 harness 都只在启动那一刻收得到模型清单(spawn 之后学不到新端点/凭据),所以这一组必须
  // 在这里就交给物化器,和令牌是同一份真值。❌ 不在客户端另算一份:分组只有网关知道,自己推的
  // 那份会比令牌宽,于是界面上选得中的模型每次调用都被网关拒。
  const switchableModels = launch.access.switchableModels.map((entry) => ({
    id: entry.alias,
    displayName: entry.displayName,
    contextWindow: entry.contextWindow,
    reasoningEfforts: entry.reasoningEfforts,
  }))
  // 空集合 = 服务端没报可切集合(旧版 edge function),于是这条会话退回「只有当前这一个模型」。
  // 那是**兼容行为、不是故障**,所以❌ 不抛;但它与「功能坏了」在产品面上长得一模一样
  // (下拉里只有一条、换过去被适配器拒),所以必须留一行 —— 否则排查要从界面一路挖到网关。
  // 实账:2026-09-07 我自己在 mac1 上就把这个状态误判成了「id 空间不一致」,编了一套不存在的机制。
  if (switchableModels.length === 0) {
    // pino 风格:**先字段后消息**(同文件其余 log 调用逐字如此)。写反了 typecheck 放过、
    // build:renderer 才红 —— 两个门吃的是不同的 tsconfig project。
    log.info({
      sessionId: input.sessionId,
      providerId: input.providerId,
      designated: launch.access.model,
    }, 'platform switchable set is empty — server returned no switchable_models; '
      + 'this session can only use its designated model')
  }
  const modelCapability = buildAcpModelCapability({
    dialect,
    engineId: input.providerId,
    model: launch.access.model,
    env,
    ...(switchableModels.length > 0 ? { platformModels: switchableModels } : {}),
    platformAccess: {
      relayUrl: platformProvider.baseUrl.replace(/\/v1$/, ''),
      token: platformProvider.apiKey,
      contextWindow: launch.access.contextWindow,
      reasoningEfforts: launch.access.reasoningEfforts,
      // #6921 令牌在哪些路由上能调哪些模型 —— 服务端随令牌算出,原样交给声明(codex 据此开出图工具)。
      callableRoutes: launch.access.callableRoutes,
    },
    ...(configuredEffort ? { reasoningEffort: configuredEffort } : {}),
  })
  /**
   * 这条腿上的模型是不是由这一家自己的物化器写进配置文件。
   *
   * 是的话,宿主这边就**一个模型键都不发**:两条路带的信息不一样(配置文件那条能带上
   * `[models.*]` 里的能力声明,环境变量那条在引擎内部合成一个临时别名、拿不到那些声明),
   * 两条都在时赢的是环境变量那条 —— 界面上那排推理档位于是成了画上去的。
   * ⇒ 模型这一维只能有一条投递路,判据在 `configFileModelSingleChannel.test.ts`。
   */
  if (modelGoesToConfigFile && !modelCapability) {
    // 声明了「走配置文件」却连模型声明都建不出来 = 这条路一个字也送不出去,而宿主这边又
    // 已经不发键了。响亮失败,❌ 别让会话带着「引擎自己的默认模型」冒充平台会话跑起来。
    throw new Error(
      `${input.providerId} 声明了模型走配置文件,却建不出模型声明(方言缺失)。`
      + '请在 engine-injection-contract 里声明它的注入方式。',
    )
  }
  const materialized = modelGoesToConfigFile
    ? { extraArgs: [] as string[], spawnEnv: {}, settingsOverride: undefined }
    : materializeModelCapability(modelCapability)
  // An engine with no dialect cannot be told which model to use, and the gateway will
  // reject every request the session makes. Refusing here is the fail-loud the spec asks
  // for; starting it anyway would burn the user's turn on a session that cannot work.
  //
  // ⚠️ 「这一维交给这一家自己的物化器」是第三种成立形态,不是空注入:它不发键是**因为**
  //    模型走的是 `modelCapability` → bundle → 配置文件那条路。这时还照旧抛,等于禁掉那条路。
  if (
    !modelGoesToConfigFile
    && !materialized.extraArgs?.length
    && !Object.keys(materialized.spawnEnv ?? {}).length
  ) {
    throw platformRefusal(
      'not-routable',
      `${input.providerId} declares no model injection dialect (engine-injection-contract); cannot pin a platform model`,
    )
  }

  // 只有「argv 归 pty 本体」的方言才把模型参数交给可见客户端。codex 的模型 `-c` 属于 app-server,
  // 挂到 TUI 上什么都钉不住；下面单独追加的无密钥 provider 声明只负责通过 remote TUI 的登录闸门。
  // 这两道 gate 一起防止 clientArgs 退化成一个通用的 argv 通道。
  // 传的是**文件路径**不是内联 JSON:那份文档里有这次会话的中转令牌,进 argv 就等于写进进程表。
  // 写不写这份 0600 settings 文档、写了之后挂哪儿,都由这一格的注入契约说了算。两个界面都要这份
  // 文档(理由同一个:用户 settings 的 env 块压得住进程环境),但**去处不同** —— 终端会话挂上可见
  // 进程自己的 argv,Chat UI 把路径放进 `_meta` 交给适配器(`--settings` 对 ACP 适配器是个不认识的参数)。
  const contract = findInjectionContract(input.providerId, input.surface)
  // 表上没有这个引擎(插件引擎)→ 沿用改动前那条按方言判的老规矩,行为不变。
  const legacyVisibleClientArgv = input.surface === 'tui'
    && dialectModelArgsTargetVisibleClient(dialect)
  const wantsSettingsDocument = contract ? needsSettingsDocument(contract) : legacyVisibleClientArgv
  const settingsOnVisibleClientArgv = contract
    ? settingsDocumentGoesOnVisibleClientArgv(contract)
    : legacyVisibleClientArgv

  // Claude 的 --settings 与用户 settings.json 有覆盖顺序要求，临时 override 必须保持单一文档。
  const dynamicClaude = !usesCredentialProxy && dialect === 'provider-env' && Boolean(materialized.settingsOverride)
  const credentialFiles = dynamicClaude
    ? await writeSessionCredentialFiles(input.sessionId)
    : null
  const settingsDocument = wantsSettingsDocument && materialized.settingsOverride
    ? dynamicClaude && credentialFiles
      ? dynamicClaudeSettings(
          input.surface === 'tui'
            ? { ...CLAUDE_TUI_BASE_SETTINGS, ...materialized.settingsOverride }
            : materialized.settingsOverride,
          credentialFiles.helperCommand,
        )
      : input.surface === 'tui'
        ? { ...CLAUDE_TUI_BASE_SETTINGS, ...materialized.settingsOverride }
        : materialized.settingsOverride
    : undefined
  let settingsPath: string | undefined
  try {
    settingsPath = settingsDocument ? await writeSessionSettingsFile(settingsDocument) : undefined
  } catch (error) {
    if (credentialFiles) {
      await Promise.all([
        rm(credentialFiles.credentialConfigPath, { force: true }),
        rm(credentialFiles.helperPath, { force: true }),
      ]).catch(() => undefined)
    }
    throw error
  }
  // Codex remote TUI owns no inference, but it still runs Codex's startup auth gate. Current Codex skips
  // that gate only when the client itself sees a custom provider declaration; OPENAI_API_KEY alone is the
  // default-provider login input and still renders the menu. Reuse the exact secret-free provider block
  // given to the app-server. The designated model is not carried here: the session-page Codex session
  // pins it on the visible TUI from the same app-server argv (codexTuiModelSelectionArgs, #6264).
  const visibleProviderArgs = contract
    && hasCredentialSink(contract, 'visibleClient', 'providerConfigArgs')
    ? codexPlatformProviderArgs(platformProvider, modelCapability?.platformCallableRoutes, modelCapability?.model)
    : []

  const result: SessionpagePlatformModel = {
    accessSessionId: launch.access.accessSessionId,
    expiresAt: launch.access.expiresAt,
    env: dynamicClaude
      ? stripClaudeStaticCredentials(launch.env as Record<string, string>)
      : usesCredentialProxy
        ? credentialProxyEnv(launch.env as Record<string, string>, launch.access, platformProvider)
        : launch.env as Record<string, string>,
    model: launch.access.model,
    spawnEnv: {
      ...(materialized.spawnEnv ?? {}),
    } as Record<string, string>,
    clientArgs: [
      ...(settingsPath && settingsOnVisibleClientArgv ? ['--settings', settingsPath] : []),
      ...visibleProviderArgs,
    ],
    adapterArgs: input.surface === 'tui' ? [] : [...(materialized.extraArgs ?? [])],
    settingsDocumentPath: settingsPath ?? null,
    platformProvider,
    contextWindow: launch.access.contextWindow ?? null,
    reasoningEfforts: launch.access.reasoningEfforts,
    modelCapability,
    switchableModels,
  }
  if (credentialProxyRoute) credentialRoutes.set(credentialProxyRoute, input.sessionId)
  activeAccessSessions.set(input.sessionId, {
    accessSessionId: launch.access.accessSessionId,
    authProvider: input.authProvider,
    token: launch.access.token,
    relayUrl: launch.access.relayUrl,
    renewUntil: Date.now() + renewedLifetimeMs(),
    settingsPath,
    credentialConfigPath: credentialFiles?.credentialConfigPath,
    helperPath: credentialFiles?.helperPath,
    credentialRoute: credentialFiles?.credentialRoute ?? credentialProxyRoute ?? undefined,
    agentUserId,
    providerId: input.providerId,
    modelId: selection?.source === 'platform' ? selection.modelId : launch.access.modelId,
    protocol: selection?.source === 'platform' ? selection.protocol : launch.access.protocol,
    surface: input.surface,
    launch: result,
    observationSink: input.onCredentialObservation,
  })
  // 指定的是这一档走不到的会员模型(#7092):会话照常起,调它那一轮由中转说清原因;界面据此刷新目录、挂上去路。
  const heldNow = activeAccessSessions.get(input.sessionId)
  if (heldNow && launch.access.membershipLocked.length) {
    noteMembershipLocked(input.sessionId, heldNow, launch.access.membershipLocked)
  }
  persistRelaySession(input.sessionId)
  input.onCredentialObservation?.({
    generation: launch.access.accessSessionId,
    source: 'lease',
    observedAt: new Date().toISOString(),
    leaseExpiresAt: launch.access.expiresAt,
    operation: 'issue',
    outcome: 'success',
    classification: 'lease-issued',
  })
  // 会话可以跑得比一个 TTL 长,而注入进去的凭据换不了值(它在启动时就写进进程环境了)——
  // 所以从现在起周期性地把**同一个** token 的有效期往后推,直到这条会话结束。
  scheduleRenewal(input.sessionId, launch.access.expiresAt)
  return result
}

/**
 * The launch this conversation's LIVE platform token was issued with, or null when none is held.
 *
 * Long-lived inference owners receive a stable loopback provider route instead of the gateway
 * token. The held launch therefore remains reusable while the route resolves each real request
 * against the current lease generation.
 */
export function heldPlatformModelForSession(sessionId: string): SessionpagePlatformModel | null {
  return activeAccessSessions.get(sessionId)?.launch ?? null
}

/** Host-only metadata for the Claude search tool; credentials stay in the runtime lease. */
export function claudePlatformSearchSession(sessionId: string): {
  model: string | null
  relayUrl: string
  callableRoutes: PlatformCallableRoutes | undefined
} | null {
  const held = activeAccessSessions.get(sessionId)
  if (held?.providerId !== 'claude') return null
  return {
    model: held.launch.model,
    relayUrl: held.relayUrl,
    callableRoutes: held.launch.modelCapability?.platformCallableRoutes,
  }
}

/** Only a real relay route, not a legacy helper, owns request-time credential admission. */
export function platformRequestsUseCredentialProxy(sessionId: string): boolean {
  const held = activeAccessSessions.get(sessionId)
  return Boolean(held?.credentialRoute && !held.credentialConfigPath)
}

/** A held platform generation is usable only while its server expiry is still in the future. */
export function platformModelIsExpired(
  platform: Pick<SessionpagePlatformModel, 'expiresAt'>,
  now = Date.now(),
): boolean {
  if (!platform.expiresAt) return false
  const expiresAt = Date.parse(platform.expiresAt)
  if (!Number.isFinite(expiresAt)) {
    throw new Error(`platform model access session has invalid expires_at: ${platform.expiresAt}`)
  }
  return now >= expiresAt
}

/** Reconcile an expired lease after host resume while keeping a helper/relay-backed process live. */
export async function reissueExpiredPlatformModelForSession(sessionId: string): Promise<boolean> {
  const held = activeAccessSessions.get(sessionId)
  if (!held || !platformModelIsExpired(held.launch)) return false
  return reissueExpiredRuntimeLease(sessionId)
}

/** Active generations whose credentials cannot be handed to a harness anymore. */
export function expiredPlatformModelSessions(): string[] {
  return [...activeAccessSessions.entries()]
    .filter(([, held]) => platformModelIsExpired(held.launch))
    .map(([sessionId]) => sessionId)
}

/**
 * Flush usage visible at a provider turn boundary while keeping the long-lived session token active.
 * Gateway request events are the primary path; this is an idempotent client-side delivery checkpoint.
 */
export async function checkpointPlatformModelForSession(sessionId: string): Promise<void> {
  const held = activeAccessSessions.get(sessionId)
  if (!held) return
  held.checkpointRequested = true
  if (held.checkpointPromise) return await held.checkpointPromise
  const pending = (async () => {
    let lastError: unknown
    let shouldCheckpoint = true
    while (shouldCheckpoint) {
      const current = activeAccessSessions.get(sessionId)
      if (!current) return
      current.checkpointRequested = false
      try {
        await checkpointPlatformModelAccess(current.authProvider, current.accessSessionId)
        lastError = undefined
      } catch (error) {
        lastError = error
      }
      // 一个在途 RPC 期间可能收到多个 provider stop/error；布尔脏位把它们合成恰好一次尾随扫描。
      // model_access_settle 自身幂等,所以重扫不会重复扣费,但能覆盖第一轮查询之后才落库的请求。
      shouldCheckpoint = activeAccessSessions.get(sessionId)?.checkpointRequested === true
    }
    if (lastError !== undefined) throw lastError
  })()
  held.checkpointPromise = pending
  try {
    await pending
  } finally {
    const current = activeAccessSessions.get(sessionId)
    if (current?.checkpointPromise === pending) current.checkpointPromise = undefined
  }
}

/**
 * composer 选的平台模型,配上这个 provider 的协议。
 *
 * 协议不是用户选的,是插件声明的(platformProtocolForEngine)。选不出协议说明这个引擎
 * 根本没法被指向平台 relay —— 目录本来就不会给它列出平台模型,能走到这里说明选择与引擎对不上,
 * 响亮失败比拿着一个用不了的 token 起会话强。
 */
function perSessionSelection(modelId: string, providerId: string): AgentModelSelection {
  const protocol = platformProtocolForEngine(providerId)
  if (!protocol) {
    throw platformRefusal(
      'not-routable',
      `${providerId} consumes no credential that can be redirected to the platform relay`,
    )
  }
  return { source: 'platform', modelId, protocol }
}

/** Settle and revoke the token a session-page session was issued, if any. */
export async function releasePlatformModelForSession(
  sessionId: string,
  expectedAccessSessionId?: string,
): Promise<void> {
  const held = activeAccessSessions.get(sessionId)
  if (!held) return
  // Adapter close notifications cross a worker boundary and may arrive after an explicit reconnect
  // has already rotated this conversation onto a new platform access session. A stale generation
  // owns neither the replacement token nor its settings document.
  if (expectedAccessSessionId !== undefined && held.accessSessionId !== expectedAccessSessionId) {
    log.info(
      { sessionId, heldAccessSessionId: held.accessSessionId, expectedAccessSessionId },
      '平台令牌结清被跳过:报告的那一份已经不是这条会话手里的那一份',
    )
    return
  }
  // ⚠️ **撤销必须留下痕迹。** 在这一行之前,「这条会话手里那张票被撤了」在日志里是**不存在的**:
  // 唯一的记录是库里那行 `revoked_at`。#5550/#5552 这一族的症状全都是「下一轮 401 /
  // Invalid token」——症状离原因隔着一层网关,而原因这一侧一声不响,查的人只能去翻库。
  // 那不是「日志少一行」,是 fail-loud 缺的一格:一个有后果的动作没有账。
  // ⚠️ 只打 id 与 conversationId,**❌ 不打令牌值、❌ 不打中转地址**。
  log.info(
    {
      sessionId,
      accessSessionId: held.accessSessionId,
      surface: held.surface,
      guarded: expectedAccessSessionId !== undefined,
    },
    '平台令牌结清:撤销这条会话手里那一份',
  )
  // 先停续期再结算:顺序反了会留下一个已结算会话的续期定时器,它醒来时会去续一条已经撤销的
  // 会话(服务端会拒,但那是白白的一次响亮失败 + 一条误导的错误日志)。
  if (held.renewTimer) clearTimeout(held.renewTimer)
  activeAccessSessions.delete(sessionId)
  relayPersistence?.sessions.remove(sessionId)
  // 覆盖文件里有这次会话的中转令牌,会话没了就不该再留在磁盘上。删失败不阻断结算 ——
  // 令牌本身马上就要被撤销,一个读不动的残留文件不值得让账结不上。
  if (held.settingsPath) {
    await rm(held.settingsPath, { force: true }).catch((error: unknown) => {
      log.error({ sessionId, file: held.settingsPath, err: error }, '删除会话 platform settings 文件失败')
    })
  }
  for (const file of [held.credentialConfigPath, held.helperPath]) {
    if (!file) continue
    await rm(file, { force: true }).catch((error: unknown) => {
      log.error({ sessionId, file, err: error }, '删除会话 platform credential 文件失败')
    })
  }
  if (held.credentialRoute) credentialRoutes.delete(held.credentialRoute)
  await revokePlatformModelAccess(held.authProvider, held.accessSessionId).catch((error: unknown) => {
    // 账本那一行留着(见 model-access 的 platform-access-ledger),下次启动由结清重试;这里只负责喊出来。
    log.error(
      { sessionId, accessSessionId: held.accessSessionId, err: error },
      '平台令牌撤销失败:账本保留这张票,下次启动结清',
    )
    throw error
  })
}

/**
 * 把某一个界面上所有还握着令牌的会话一起结清。
 *
 * 用在「承载这些会话的那个运行时整个没了」的时候(ACP 运行时进程被 dispose)。按界面筛而不是
 * 全清:同一张表里还躺着终端会话的令牌,而那些会话的进程活得好好的 —— 一起撤掉就是把用户正在
 * 用的终端会话打成每轮 401(台账 3 号的形状)。
 */
export async function releasePlatformModelsForSurface(surface: InjectionSurface): Promise<void> {
  await releasePlatformModels((held) => held.surface === surface)
}

/**
 * 宿主退出:结清本进程手里的令牌,只留下「会话还在 tmux 里跑、且凭据不经宿主供给」的那几张。
 *
 * tmux detach 的意义就是让进程活得比宿主久。凭据写进进程环境的会话(没有 credentialRoute)退出后照样能用它的票,
 * 这时撤掉就是让它正在跑的那一轮当场失败 ⇒ 不撤,账本行标 detached,由下次启动的宿主接回续期或结清。
 * 不撤的代价有界:宿主是唯一续期者,没人接回的票至多一个续期周期后自然失效,而账本里有它。
 * 凭据由宿主供给的会话(credentialRoute:取票 helper 或回环代理)在宿主退出那一刻就断了粮,留着票也没人能用 ⇒ 照撤。
 * 退出窗口里没撤完的,账本行仍在,下次启动结清。
 */
/**
 * 这条会话的票能不能留给下一个宿主:凭据写进进程环境的一直能;宿主供给的(取票脚本 / 回环代理 / 宿主写的文件)
 * 只有配了落盘(#6264)、且它那一行确实写进了盘时才能 —— 否则下一个宿主认不回来,留着就是断粮。
 */
function canOutliveHost(sessionId: string, held: { credentialRoute?: string; settingsPath?: string; credentialConfigPath?: string; helperPath?: string }): boolean {
  const hostSupplied = Boolean(held.credentialRoute || held.settingsPath || held.credentialConfigPath || held.helperPath)
  if (!hostSupplied) return true
  return Boolean(held.credentialRoute)
    && (relayPersistence?.sessions.list().some((record) => record.key === sessionId) ?? false)
}

export async function releasePlatformModelsAtExit(liveDetachedSessions: ReadonlySet<string> | null): Promise<void> {
  // 只有终端会话能活在 tmux 里;凭据或文件由宿主供给(取票 route / 回环代理 / 宿主写的 0600 文件)的会话,
  // 宿主一走就断粮,而那些文件下次启动会被收尸 ⇒ 不保留。
  // `liveDetachedSessions` 为 null = 读不出 tmux:候选全部保留、标 detached,交给下次启动判定 ——
  // 错留一张至多占一个续期周期,错撤一张会让那一轮当场失败。
  const kept = [...activeAccessSessions.entries()].filter(([sessionId, held]) =>
    held.surface === 'tui'
    && (canOutliveHost(sessionId, held))
    && (liveDetachedSessions === null || liveDetachedSessions.has(sessionId)))
  for (const [sessionId, held] of kept) {
    if (held.renewTimer) clearTimeout(held.renewTimer)
    activeAccessSessions.delete(sessionId)
    // #6264 宿主供给凭据的那类:文件、路由、盘上那一行都留着,下一个宿主绑回端口前认回(restorePlatformRelaySessions)。
    if (held.credentialRoute) credentialRoutes.delete(held.credentialRoute)
  }
  await Promise.all(kept.map(([sessionId, held]) => markPlatformAccessDetached(held.accessSessionId).then(
    () => log.info({ sessionId, accessSessionId: held.accessSessionId }, '平台令牌随 tmux 会话保留,账本行标 detached'),
    (error: unknown) => {
      // 标不上 = 下次启动会把它当普通残留撤掉:让那一轮失败,但不会留下没人知道的票。响亮记一笔。
      log.error({ sessionId, accessSessionId: held.accessSessionId, err: error }, '平台令牌标 detached 失败,下次启动会被结清')
    },
  )))
  await Promise.all([
    releasePlatformModels(() => true),
    settleAdoptedPlatformAccessAtExit(liveDetachedSessions),
  ])
}

/**
 * 同时在飞的撤销上限。每次撤销在服务端都要结算用量,而 edge worker 的 CPU 预算按 worker 算(软 1s / 硬 2s):
 * 一次把 N 张全压过去会撞上限,worker 被退役或取消,连同同一 worker 上别人的请求一起失败
 * (#6185:29 张同落一个 worker,全部取消;mac1 实测 13 张并发也撞到软上限、丢了 1 张)。
 * 串行又撑不满退出窗口。几条并行是两者的折中;撤不完的账本还在,下次启动结清。
 */
const RELEASE_CONCURRENCY = 4

// 一条失败不连累其它条(失败已在 release 里响亮记账、账本保留)。
async function releasePlatformModels(select: (held: { surface: InjectionSurface }) => boolean): Promise<void> {
  const doomed = [...activeAccessSessions.entries()]
    .filter(([, held]) => select(held))
    .map(([sessionId]) => sessionId)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < doomed.length) {
      const sessionId = doomed[next++]
      await releasePlatformModelForSession(sessionId).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(RELEASE_CONCURRENCY, doomed.length) }, lane))
}
