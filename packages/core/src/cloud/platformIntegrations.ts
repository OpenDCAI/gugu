/**
 * #921 人自己填的凭据(key / token,高德先上)由平台保管:管家 `/integrations` 接口的客户端。
 * 人在一台设备上填一次,平台加密存着;他的每台设备(含云电脑)都经平台的 MCP 转发口用它,凭据 ❌ 回到任何设备。
 * 地址、鉴权与聊天渠道同一扇门(`cloudComputerBaseUrl`,用户自己的 JWT);服务配置故障回 503 unavailable。
 *
 *  · GET    /integrations                        → { providers: [{ provider, accounts: [{ accountId, connected, state, updatedAt, checkedAt, disconnectedAt }] }] }
 *           state:connected · reconnect(存着、但对方不认了 / 换钥后解不开,要重连) · not_connected(没存,时间为空)
 *           disconnectedAt:这个人最近一次断开它的时刻(明确再连一次就清掉),没断开过 = null。state 与 disconnectedAt 每一行都有
 *  · PUT    /integrations/:provider/credential   { fields, connect: "manual" } | { fields, migration: { savedAt } }
 *           → { connected: true, updatedAt, checkedAt }
 *           出错:400 invalid_fields · 404 unknown_provider · 422 auth_failed · 502 upstream_unavailable · 503 unavailable
 *           `connect: "manual"` = 人在连接页填的:只有它覆盖已存着的、清掉断开记录。
 *           `migration` = 设备上 #649 留下的 key 搬上来,只能新建:平台已存着 = 409 already_connected;
 *           断开过、且断开晚于 savedAt(或 savedAt 为空)= 409 disconnected_after。
 *           ❌ 发不带标记的 PUT(平台当成 savedAt 为空的搬迁);两个标记一起、connect 不是 "manual" = 400
 *  · DELETE /integrations/:provider/credential   → 204(平台记下断开的时刻)
 *  · POST|GET|DELETE /integrations/:provider/mcp  MCP Streamable HTTP 转发口,凭据由平台挂上;
 *           没存 = 404 not_connected;对方拒了存着的凭据 = 409 credential_rejected(401 只留给本人的登录失效);
 *           暂时的:408 request_timeout、429 too_many_streams(同一人同时开着的太多)/ rate_limited,带 retry-after;
 *           不收:400 invalid_request(请求体读不出)、413 too_large(一批里 tools/call 超过 60 个);
 *           对方这会儿用不了(额度、QPS、临时错误):502 upstream_unavailable
 *
 * 只有一种情况凭据留在设备上:这个安装压根没有这项服务(社区自托管,没部署云电脑管家)—— 网关回 404、体里没有
 * 平台的出错码，或入口回 503 not_open 表示未配置管家(`isPlatformServiceMissing`)。平台的 503 unavailable
 * 是服务故障，保留平台保管方式并报告失败，不改存本机。
 *
 * 不碰 node / electron。
 */
import { CloudComputerError, cloudComputerErrorFromResponse, isCloudComputerNotOpen } from './cloudComputer'
import { anySignal } from '../shared/anySignal'

export type PlatformIntegrationAccount = {
  accountId: string
  /** false = 平台存着,但用不了了(对方不认、换钥后解不开):要重连。 */
  connected: boolean
  /** 「没存」的那种(not_connected)不在这里 —— 那就是没有这一行。 */
  state: 'connected' | 'reconnect'
  updatedAt: string | null
  checkedAt: string | null
}

export type PlatformIntegrationProvider = {
  provider: string
  /** 平台存着的账号(连着的、要重连的);没存的不在这里。 */
  accounts: PlatformIntegrationAccount[]
  /** accountId → 这个人最近一次断开它的时刻(没断开过的不在里面)。 */
  disconnectedAt: Record<string, string>
}

/** #649 留在设备上的 key 搬上平台时带上:平台据此不覆盖已存着的、不推翻这个人断开过的。savedAt = null:不知道它是什么时候存的。 */
export type PlatformCredentialMigration = { savedAt: string | null }

/** 每一次 PUT 都说清是谁在存:人在连接页填的(`manual`),或 #649 那把 key 的搬迁。没有第三种。 */
export type PlatformCredentialSource = { connect: 'manual' } | { migration: PlatformCredentialMigration }

export type PlatformCredentialSaved = { connected: true; updatedAt: string | null; checkedAt: string | null }

/**
 * 转发口不收这一次请求:读不出(400 invalid_request)、一批里工具调用太多(413 too_large)。不是没连、不是要重连、
 * 也不是过会儿就好 —— 照实说被拒的是什么。
 */
export class PlatformForwarderRefusedError extends Error {
  constructor(readonly provider: string, readonly reason: 'invalid_request' | 'too_large') {
    super(
      reason === 'too_large'
        ? `Too many ${provider} tool calls in one request for the Gugu platform; send fewer at a time.`
        : `The Gugu platform could not read this ${provider} request.`,
    )
    this.name = 'PlatformForwarderRefusedError'
  }
}

/** 转发口说对方回了话、但这会儿用不了(额度、QPS、临时错误;502 upstream_unavailable):稍后再试,❌ 重连、❌ 登录。 */
export class PlatformProviderUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} isn't available right now; try again later.`)
    this.name = 'PlatformProviderUnavailableError'
  }
}

/** 会话里那台转发的 MCP 每次调用现取的地址、请求头,和认得转发口那两句「不成」的 fetch。 */
export type PlatformMcpEndpoint = { url: string; headers: Record<string, string>; fetch: typeof fetch }

/** 转发口说这一家没存凭据(在哪台设备上断开过,或从没连过)。 */
export class PlatformIntegrationNotConnectedError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} is not connected in Gugu any more; reconnect it.`)
    this.name = 'PlatformIntegrationNotConnectedError'
  }
}

/**
 * 转发口暂时转不了:同一人同时开着的调用太多(429 too_many_streams)、被限流(429 rate_limited)、超时(408 request_timeout)。
 * 过一会儿再试就好 —— ❌ 说成「没连」「要重连」或登录问题。
 */
export class PlatformForwarderBusyError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'too_many_streams' | 'rate_limited' | 'request_timeout',
    readonly retryAfterSeconds: number | null,
  ) {
    const when = retryAfterSeconds ? `try again in ${retryAfterSeconds} s` : 'try again shortly'
    super(
      reason === 'too_many_streams'
        ? `Too many ${provider} calls are open at once on the Gugu platform; ${when}.`
        : reason === 'rate_limited'
          ? `${provider} calls are being rate-limited by the Gugu platform; ${when}.`
          : `This ${provider} call didn't reach the Gugu platform in time; ${when}.`,
    )
    this.name = 'PlatformForwarderBusyError'
  }
}

/** `AbortSignal.timeout(…)` 到点时的原因。 */
function isTimeout(reason: unknown): boolean {
  return (reason as { name?: unknown } | null)?.name === 'TimeoutError'
}

/** `retry-after`:秒数,或一个 HTTP 日期;读不出来 = null。 */
function retryAfterSeconds(header: string | null): number | null {
  const value = header?.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) return Number(value) > 0 ? Number(value) : null
  const at = Date.parse(value)
  return Number.isFinite(at) && at > Date.now() ? Math.ceil((at - Date.now()) / 1000) : null
}

/** 转发口说对方不认平台存着的那份凭据了(过期、被撤):要重连,❌ 不是登录问题。 */
export class PlatformCredentialRejectedError extends Error {
  constructor(readonly provider: string) {
    super(`The saved ${provider} credential was rejected; reconnect it in Gugu.`)
    this.name = 'PlatformCredentialRejectedError'
  }
}

/**
 * 这个安装没有这项服务:网关自己回的 404(Supabase「Requested function was not found」、自托管网关「no Route matched」),
 * 体里没有平台的出错码；或云端入口回 not_open 明确表示未配置可选管家。平台自己回的 404(unknown_provider / not_connected / not_found)、503 unavailable、网络不通都 ❌ 算。
 */
export function isPlatformServiceMissing(error: unknown): boolean {
  return isCloudComputerNotOpen(error)
    || error instanceof CloudComputerError && error.status === 404 && error.code === 'http_404'
}

export type PlatformIntegrationsClient = {
  list(signal?: AbortSignal): Promise<PlatformIntegrationProvider[]>
  /** 同一个读,外加平台答话时它自己的钟(应答的 `Date` 头,毫秒,整秒精度);没给这个头 = null。 */
  listWithClock(signal?: AbortSignal): Promise<{ providers: PlatformIntegrationProvider[]; platformNow: number | null }>
  /** 连接页:`{ connect: 'manual' }`;#649 搬上来的 key:`{ migration }`。 */
  saveCredential(
    provider: string,
    fields: Record<string, string>,
    source: PlatformCredentialSource,
    signal?: AbortSignal,
  ): Promise<PlatformCredentialSaved>
  deleteCredential(provider: string, signal?: AbortSignal): Promise<void>
  mcpEndpoint(
    provider: string,
    hooks?: { onNotConnected?: () => void; onCredentialRejected?: () => void },
  ): Promise<PlatformMcpEndpoint>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 时间照平台给的原样留着(ISO)。 */
const timestamp = text

function badResponse(what: string): CloudComputerError {
  return new CloudComputerError(200, 'bad_response', `cloud-computer ${what} returned an unexpected shape`)
}

/** GET /integrations 的应答 → 每一家的账号;形状不对就抛(❌ 当成「哪家都没连」)。 */
export function parsePlatformIntegrations(value: unknown): PlatformIntegrationProvider[] {
  const providers = (value as { providers?: unknown } | null)?.providers
  if (!Array.isArray(providers)) throw badResponse('/integrations')
  return providers.map((entry: unknown) => {
    const row = entry as { provider?: unknown; accounts?: unknown } | null
    const provider = text(row?.provider)
    if (!provider || !Array.isArray(row?.accounts)) throw badResponse('/integrations')
    const disconnectedAt: Record<string, string> = {}
    const accounts: PlatformIntegrationAccount[] = []
    for (const raw of row.accounts as unknown[]) {
      const account = raw as Record<string, unknown> | null
      const accountId = text(account?.accountId)
      const state = account?.state
      if (!accountId || (state !== 'connected' && state !== 'reconnect' && state !== 'not_connected') || !account || !('disconnectedAt' in account)) {
        throw badResponse('/integrations')
      }
      const at = timestamp(account.disconnectedAt)
      if (at) disconnectedAt[accountId] = at
      // 平台说这一行没存:就是没有这一行,❌ 当成「要重连」。
      if (state === 'not_connected') continue
      accounts.push({ accountId, connected: state === 'connected', state, updatedAt: timestamp(account.updatedAt), checkedAt: timestamp(account.checkedAt) })
    }
    return { provider, accounts, disconnectedAt }
  })
}

/**
 * 每个请求最多等这么久。平台试一把 key 最长 30 s(它去问高德),它的公网入口给控制器 60 s:
 * 取 45 s —— 比 30 s 的试 key 多留 15 s 给来回和转发,又在入口掐断之前自己先放手(放手后连接页会重读一次列表)。
 */
export const PLATFORM_REQUEST_TIMEOUT_MS = 45_000

export function createPlatformIntegrationsClient(options: {
  baseUrl: string
  accessToken: () => Promise<string>
  anonKey?: string | null
  fetch?: typeof fetch
  requestTimeoutMs?: number
}): PlatformIntegrationsClient {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? PLATFORM_REQUEST_TIMEOUT_MS
  const headers = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await options.accessToken()}`,
    ...(options.anonKey ? { apikey: options.anonKey } : {}),
  })
  const providerPath = (provider: string) => `${options.baseUrl}/integrations/${encodeURIComponent(provider)}`
  const request = async (
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ raw: string; platformNow: number | null }> => {
    const init: Record<string, string> = await headers()
    if (body !== undefined) init['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    let raw: string
    try {
      response = await doFetch(url, {
        method,
        headers: init,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: anySignal([signal, timeout]),
      })
      raw = await response.text()
    } catch (error) {
      // 调用方有意取消:原样还给它。调用方自己限的时到了,和这里的超时一样是「没等到回话」——
      // ❌ 把运行时那句英文(The operation was aborted due to timeout)交出去。
      if (signal?.aborted && !isTimeout(signal.reason)) throw error
      const where = url.slice(options.baseUrl.length)
      if (timeout.aborted) throw new CloudComputerError(0, 'network', `${method} ${where} got no answer within ${Math.round(timeoutMs / 1000)} s`)
      if (signal?.aborted) throw new CloudComputerError(0, 'network', `${method} ${where} got no answer in time`)
      throw new CloudComputerError(0, 'network', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw cloudComputerErrorFromResponse(response.status, raw)
    const date = Date.parse(response.headers.get('date') ?? '')
    return { raw, platformNow: Number.isFinite(date) ? date : null }
  }
  const json = (raw: string, what: string): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      throw badResponse(what)
    }
  }
  const listWithClock = async (signal?: AbortSignal) => {
    const { raw, platformNow } = await request('GET', `${options.baseUrl}/integrations`, undefined, signal)
    return { providers: parsePlatformIntegrations(json(raw, '/integrations')), platformNow }
  }
  return {
    list: async (signal) => (await listWithClock(signal)).providers,
    listWithClock,
    saveCredential: async (provider, fields, source, signal) => {
      const body = 'connect' in source ? { fields, connect: 'manual' } : { fields, migration: { savedAt: source.migration.savedAt } }
      const saved = json((await request('PUT', `${providerPath(provider)}/credential`, body, signal)).raw, 'PUT credential') as Record<string, unknown> | null
      if (saved?.connected !== true) throw badResponse('PUT credential')
      return { connected: true, updatedAt: timestamp(saved.updatedAt), checkedAt: timestamp(saved.checkedAt) }
    },
    deleteCredential: async (provider, signal) => {
      await request('DELETE', `${providerPath(provider)}/credential`, undefined, signal)
    },
    mcpEndpoint: async (provider, hooks) => ({
      url: `${providerPath(provider)}/mcp`,
      headers: await headers(),
      // 转发口的几句「不成」各说各的:没存 = 没连;存着的被对方拒了 = 要重连;太多 / 限流 / 超时 = 过会儿再试;
      // 读不出 / 一批太多 = 照实说不收;对方这会儿用不了 = 稍后再试。
      // 别的应答原样交给 MCP 客户端。任何一次转发都可能遇上,不只是 initialize。
      fetch: async (input, init) => {
        const response = await doFetch(input, init)
        if (![400, 404, 408, 409, 413, 429, 502].includes(response.status)) return response
        const code = cloudComputerErrorFromResponse(response.status, await response.clone().text().catch(() => '')).code
        if (response.status === 400 && code === 'invalid_request') throw new PlatformForwarderRefusedError(provider, 'invalid_request')
        if (response.status === 413) throw new PlatformForwarderRefusedError(provider, 'too_large')
        if (response.status === 502 && code === 'upstream_unavailable') throw new PlatformProviderUnavailableError(provider)
        if (response.status === 429 || response.status === 408) {
          const reason = response.status === 408 ? 'request_timeout' : code === 'too_many_streams' ? 'too_many_streams' : 'rate_limited'
          throw new PlatformForwarderBusyError(provider, reason, retryAfterSeconds(response.headers.get('retry-after')))
        }
        if (response.status === 404 && code === 'not_connected') {
          hooks?.onNotConnected?.()
          throw new PlatformIntegrationNotConnectedError(provider)
        }
        if (response.status === 409 && code === 'credential_rejected') {
          hooks?.onCredentialRejected?.()
          throw new PlatformCredentialRejectedError(provider)
        }
        return response
      },
    }),
  }
}
