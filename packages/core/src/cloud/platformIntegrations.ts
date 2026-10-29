/**
 * #921 人自己填的凭据(key / token,高德先上)由平台保管:管家 `/integrations` 接口的客户端。
 * 人在一台设备上填一次,平台加密存着;他的每台设备(含云电脑)都经平台的 MCP 转发口用它,凭据 ❌ 回到任何设备。
 * 地址、鉴权与聊天渠道同一扇门(`cloudComputerBaseUrl`,用户自己的 JWT);这扇门说 503 not_open = 这个环境没开放。
 *
 *  · GET    /integrations                        → { providers: [{ provider, accounts: [{ accountId, connected, updatedAt, checkedAt }] }] }
 *  · PUT    /integrations/:provider/credential   { fields } → { connected: true, updatedAt, checkedAt }
 *           出错:400 invalid_fields · 404 unknown_provider · 422 auth_failed · 502 upstream_unavailable · 503 not_open
 *  · DELETE /integrations/:provider/credential   → 204
 *  · POST|GET|DELETE /integrations/:provider/mcp  MCP Streamable HTTP 转发口,凭据由平台挂上;
 *           没存 = 404 not_connected;对方拒了存着的凭据 = 409 credential_rejected(401 只留给本人的登录失效)
 *
 * 只有一种情况凭据留在设备上:这个安装压根没有这项服务(社区自托管,没部署云电脑管家)—— 网关回 404、体里没有
 * 平台的出错码(`isPlatformServiceMissing`)。平台在、但说 503 not_open(没对这个人开放 / 没配好)❌ 是退路:
 * 照实说「还没对你开放」,不在本机存。
 *
 * 不碰 node / electron。
 */
import { CloudComputerError, cloudComputerErrorFromResponse } from './cloudComputer'

export type PlatformIntegrationAccount = {
  accountId: string
  /** false = 平台存着,但对方上一次不认它(要重连)。 */
  connected: boolean
  updatedAt: string | null
  checkedAt: string | null
}

export type PlatformIntegrationProvider = { provider: string; accounts: PlatformIntegrationAccount[] }

export type PlatformCredentialSaved = { connected: true; updatedAt: string | null; checkedAt: string | null }

/** 会话里那台转发的 MCP 每次调用现取的地址、请求头,和认得转发口那两句「不成」的 fetch。 */
export type PlatformMcpEndpoint = { url: string; headers: Record<string, string>; fetch: typeof fetch }

/** 转发口说这一家没存凭据(在哪台设备上断开过,或从没连过)。 */
export class PlatformIntegrationNotConnectedError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} is not connected in Gugu any more; reconnect it.`)
    this.name = 'PlatformIntegrationNotConnectedError'
  }
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
 * 体里没有平台的出错码。平台自己回的 404(unknown_provider / not_connected / not_found)、503 not_open、网络不通都 ❌ 算。
 */
export function isPlatformServiceMissing(error: unknown): boolean {
  return error instanceof CloudComputerError && error.status === 404 && error.code === 'http_404'
}

export type PlatformIntegrationsClient = {
  list(signal?: AbortSignal): Promise<PlatformIntegrationProvider[]>
  saveCredential(provider: string, fields: Record<string, string>, signal?: AbortSignal): Promise<PlatformCredentialSaved>
  deleteCredential(provider: string, signal?: AbortSignal): Promise<void>
  mcpEndpoint(
    provider: string,
    hooks?: { onNotConnected?: () => void; onCredentialRejected?: () => void },
  ): Promise<PlatformMcpEndpoint>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 时间照平台给的原样留着(ISO);给的是毫秒数也认。 */
function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return text(value)
}

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
    return {
      provider,
      accounts: row.accounts.map((raw: unknown) => {
        const account = raw as Record<string, unknown> | null
        const accountId = text(account?.accountId)
        if (!accountId || typeof account?.connected !== 'boolean') throw badResponse('/integrations')
        return { accountId, connected: account.connected, updatedAt: timestamp(account.updatedAt), checkedAt: timestamp(account.checkedAt) }
      }),
    }
  })
}

export function createPlatformIntegrationsClient(options: {
  baseUrl: string
  accessToken: () => Promise<string>
  anonKey?: string | null
  fetch?: typeof fetch
  requestTimeoutMs?: number
}): PlatformIntegrationsClient {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? 20_000
  const headers = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await options.accessToken()}`,
    ...(options.anonKey ? { apikey: options.anonKey } : {}),
  })
  const providerPath = (provider: string) => `${options.baseUrl}/integrations/${encodeURIComponent(provider)}`
  const request = async (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<string> => {
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
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      raw = await response.text()
    } catch (error) {
      if (signal?.aborted) throw error
      const where = url.slice(options.baseUrl.length)
      if (timeout.aborted) throw new CloudComputerError(0, 'network', `${method} ${where} got no answer within ${Math.round(timeoutMs / 1000)} s`)
      throw new CloudComputerError(0, 'network', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw cloudComputerErrorFromResponse(response.status, raw)
    return raw
  }
  const json = (raw: string, what: string): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      throw badResponse(what)
    }
  }
  return {
    list: async (signal) => parsePlatformIntegrations(json(await request('GET', `${options.baseUrl}/integrations`, undefined, signal), '/integrations')),
    saveCredential: async (provider, fields, signal) => {
      const saved = json(await request('PUT', `${providerPath(provider)}/credential`, { fields }, signal), 'PUT credential') as Record<string, unknown> | null
      if (saved?.connected !== true) throw badResponse('PUT credential')
      return { connected: true, updatedAt: timestamp(saved.updatedAt), checkedAt: timestamp(saved.checkedAt) }
    },
    deleteCredential: async (provider, signal) => {
      await request('DELETE', `${providerPath(provider)}/credential`, undefined, signal)
    },
    mcpEndpoint: async (provider, hooks) => ({
      url: `${providerPath(provider)}/mcp`,
      headers: await headers(),
      // 转发口的两句「不成」各说各的:没存 = 没连;存着的被对方拒了 = 要重连。别的应答原样交给 MCP 客户端。
      fetch: async (input, init) => {
        const response = await doFetch(input, init)
        if (response.status !== 404 && response.status !== 409) return response
        const code = cloudComputerErrorFromResponse(response.status, await response.clone().text().catch(() => '')).code
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
