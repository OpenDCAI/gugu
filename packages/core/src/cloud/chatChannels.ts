/**
 * #7199 聊天渠道(微信等):管家替用户挂着收发,桌面关了照样能聊;这里是它 `/channels` 接口的客户端
 * (服务端:nmhjklnm/gugu-supabase services/cloud-computer/src/channels,接口表见那边 http.ts 文件头)。
 * 地址、鉴权与云电脑同一扇门(`cloudComputerBaseUrl`);服务配置故障按普通请求失败报告,保留连接并允许重试。
 *
 * 不碰 node / electron:渲染层(设置 → 聊天渠道)与主进程(把本机旧连接交给管家)共用。
 */
import { CloudComputerError, cloudComputerErrorFromResponse } from './cloudComputer'

export type ChatChannelKind = 'wechat' | 'feishu' | 'dingtalk' | 'telegram'

export type ChatChannelHealth =
  | { state: 'starting' }
  | { state: 'running' }
  /** 渠道说凭据失效,管家隔一阵自动再试(微信暂停一小时)。 */
  | { state: 'paused'; until: number }
  /** 连不上渠道的服务器,在重试。 */
  | { state: 'retrying'; since: number }
  /** 存着的连接打不开,要重新扫码。 */
  | { state: 'broken' }

export interface ChatChannel {
  kind: ChatChannelKind
  accountLabel: string | null
  /** 对接的 agent;null = 还没选。 */
  agentId: string | null
  /** 默认聊天工具:agent 主动找你也推到这里。 */
  isDefault: boolean
  connectedAt: string
  health: ChatChannelHealth
  lastInboundAt: number | null
  lastOutboundAt: number | null
}

export interface ChatChannelList {
  channels: ChatChannel[]
  /** 连上时默认对接谁(他的「个人助理」);没有 = null。 */
  suggestedAgentId: string | null
  /** 这个环境能连的种类。 */
  kinds: ChatChannelKind[]
}

/** expired 且 everScanned=false:也可能是扫了被微信风控拦下(服务端分不出来)。save_failed = 连上了但管家没存下。 */
export type ChatChannelLoginFailure = 'expired' | 'verify_blocked' | 'network' | 'already_bound' | 'protocol' | 'save_failed'

export type ChatChannelLogin =
  | { phase: 'loading' }
  | { phase: 'qr'; qrcodeUrl: string }
  | { phase: 'scanned' }
  | { phase: 'verify'; wrongCode: boolean }
  | { phase: 'connected' }
  | { phase: 'failed'; reason: ChatChannelLoginFailure; everScanned: boolean }

export type ChatChannelsClient = {
  list(signal?: AbortSignal): Promise<ChatChannelList>
  startLogin(kind: ChatChannelKind): Promise<ChatChannelLogin>
  loginView(kind: ChatChannelKind, signal?: AbortSignal): Promise<ChatChannelLogin | null>
  submitVerifyCode(kind: ChatChannelKind, code: string): Promise<ChatChannelLogin>
  cancelLogin(kind: ChatChannelKind): Promise<void>
  setAgent(kind: ChatChannelKind, agentId: string | null): Promise<ChatChannelList>
  setDefault(kind: ChatChannelKind | null): Promise<ChatChannelList>
  disconnect(kind: ChatChannelKind): Promise<ChatChannelList>
  /** 桌面第一版在本机连过的那份交给管家;管家已经有这一种 = already_connected(不动它)。 */
  importLegacy(kind: ChatChannelKind, input: { legacy: unknown; agentId: string | null; connectedAt: number }): Promise<'imported' | 'already_connected'>
}

export function createChatChannelsClient(options: {
  baseUrl: string
  accessToken: () => Promise<string>
  anonKey?: string | null
  fetch?: typeof fetch
  requestTimeoutMs?: number
}): ChatChannelsClient {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? 20_000
  const request = async <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await options.accessToken()}` }
    if (options.anonKey) headers.apikey = options.anonKey
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    let raw: string
    try {
      response = await doFetch(`${options.baseUrl}/channels${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      raw = await response.text()
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new CloudComputerError(0, 'network', `channels ${method} ${path} got no answer within ${Math.round(timeoutMs / 1000)} s`)
      throw new CloudComputerError(0, 'network', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw cloudComputerErrorFromResponse(response.status, raw)
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new CloudComputerError(response.status, 'bad_response', `channels ${method} ${path} returned non-JSON: ${raw.slice(0, 200)}`)
    }
  }
  return {
    list: (signal) => request<ChatChannelList>('GET', '', undefined, signal),
    startLogin: async (kind) => (await request<{ login: ChatChannelLogin }>('POST', `/${kind}/login`, {})).login,
    loginView: async (kind, signal) => (await request<{ login: ChatChannelLogin | null }>('GET', `/${kind}/login`, undefined, signal)).login,
    submitVerifyCode: async (kind, code) => (await request<{ login: ChatChannelLogin }>('POST', `/${kind}/login/verify`, { code })).login,
    cancelLogin: async (kind) => {
      await request('DELETE', `/${kind}/login`)
    },
    setAgent: (kind, agentId) => request<ChatChannelList>('POST', `/${kind}/settings`, { agentId }),
    setDefault: (kind) => request<ChatChannelList>('POST', '/default', { kind }),
    disconnect: (kind) => request<ChatChannelList>('DELETE', `/${kind}`),
    importLegacy: async (kind, input) => (await request<{ result: 'imported' | 'already_connected' }>('POST', `/${kind}/import`, input)).result,
  }
}
