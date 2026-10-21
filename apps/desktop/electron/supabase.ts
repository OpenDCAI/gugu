import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { net } from 'electron'
import WebSocket from 'ws'
import { createLogger } from './lib/logger'

const realtimeLog = createLogger('realtime')

// #5331 主进程里所有云往返共用 Chromium 的连接池:已用过的空闲连接保活约 5 分钟,不像 Node 全局 fetch
// (undici 默认 keepAliveTimeout 4 s)那样在两次新建会话之间断掉、下一发重握 0.95 s 的 TLS。
export const electronFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  net.fetch(
    input instanceof URL ? input.toString() : (input as RequestInfo),
    init as Parameters<typeof net.fetch>[1]
  )) as typeof fetch

const electronRealtime = {
  // @@@electron-realtime-transport - Electron main runs in Node, so pin Realtime to ws instead of environment-detected globals.
  transport: WebSocket as never,
  logger: (kind: string, message: string, payload?: unknown) => {
    if (kind !== 'receive') return
    const fields = message.trim().split(/\s+/)
    const eventIndex = fields.findIndex((field) => field === 'phx_close' || field === 'phx_error' || field === 'phx_reply')
    if (eventIndex < 1) return
    const topic = fields[eventIndex - 1]
    const event = fields[eventIndex]
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const response = data.response && typeof data.response === 'object' ? data.response as Record<string, unknown> : {}
    if (event === 'phx_reply' && fields[0] !== 'error') return
    const reason = typeof data.reason === 'string'
      ? data.reason
      : typeof response.reason === 'string'
        ? response.reason
        : typeof response.message === 'string'
          ? response.message
          : undefined
    const responseStatus = typeof data.status === 'string'
      ? data.status
      : typeof response.status === 'string'
        ? response.status
        : undefined
    realtimeLog.warn({
      event,
      topic: realtimeTopicSuffix(topic),
      ...(reason ? { reason } : {}),
      ...(responseStatus ? { status: responseStatus } : {}),
    }, 'Realtime channel error')
  }
}

function realtimeTopicSuffix(topic: string | undefined): string {
  const parts = topic?.split(':') ?? []
  if (parts[0] !== 'realtime' || parts[1] !== 'gugu') {
    const suffix = parts.at(-1) ?? '<unknown>'
    return /^[0-9a-f-]{16,}$/i.test(suffix) ? '<id>' : suffix
  }
  if (parts[2] === 'user') return parts.slice(2).map((part, index) => index === 1 ? '<id>' : part).join(':')
  return parts.slice(3).map((part) => /^[0-9a-f-]{16,}$/i.test(part) ? '<id>' : part).join(':') || '<root>'
}

// Construct lazily: merely importing this module (e.g. from contract-check
// tooling that has no Supabase env) must not build a client. The env
// requirement (no hardcoded fallback) is enforced on first real use, not at
// import time.
type ElectronSupabaseClient = ReturnType<typeof createGuguSupabaseClient>
let cachedSupabase: ElectronSupabaseClient | null = null
function resolveSupabase(): ElectronSupabaseClient {
  return (cachedSupabase ??= createGuguSupabaseClient({
    fetch: electronFetch,
    realtime: electronRealtime
  }))
}

export const supabase = new Proxy({} as ElectronSupabaseClient, {
  get(_target, prop) {
    const client = resolveSupabase() as unknown as Record<PropertyKey, unknown>
    const value = client[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value
  }
}) as ElectronSupabaseClient

// Returns an authenticated identity-schema client using the caller's access token.
export function makeIdentityClient(accessToken: string) {
  return createGuguSupabaseClient({
    schema: 'identity',
    fetch: electronFetch,
    realtime: electronRealtime,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

// Returns an authenticated chat-schema client (messages / chat_members). Used host-side for the
// thread bootstrap fetch (#1196 Q1); RLS applies (messages_view is security_invoker).
export function makeChatClient(accessToken: string) {
  return createGuguSupabaseClient({
    schema: 'chat',
    fetch: electronFetch,
    realtime: electronRealtime,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}
