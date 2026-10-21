import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { net } from 'electron'
import WebSocket from 'ws'

// #5331 主进程里所有云往返共用 Chromium 的连接池:已用过的空闲连接保活约 5 分钟,不像 Node 全局 fetch
// (undici 默认 keepAliveTimeout 4 s)那样在两次新建会话之间断掉、下一发重握 0.95 s 的 TLS。
export const electronFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  net.fetch(
    input instanceof URL ? input.toString() : (input as RequestInfo),
    init as Parameters<typeof net.fetch>[1]
  )) as typeof fetch

const electronRealtime = {
  // @@@electron-realtime-transport - Electron main runs in Node, so pin Realtime to ws instead of environment-detected globals.
  transport: WebSocket as never
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
