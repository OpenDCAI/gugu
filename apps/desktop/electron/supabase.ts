import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { net } from 'electron'
import WebSocket from 'ws'
import { pauseElectronRealtimeChannels, reconnectElectronRealtimeChannels } from './realtime-channel'
import { createLogger } from './lib/logger'

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
let currentAccessToken: ((forceRefresh?: boolean) => Promise<string | null>) | null = null

/** 账号拥有登录态;频道只从这里现取,不能各自保存一枚令牌去改整条共享连接。 */
export function bindElectronSupabaseAuth(provider: (forceRefresh?: boolean) => Promise<string | null>): void {
  currentAccessToken = provider
}

export async function refreshElectronSupabaseAuth(): Promise<void> {
  await cachedSupabase?.realtime.setAuth()
}

/** A suspended kernel preserves sockets that the server has already dropped.
 * Close them proactively; inbox REST reconciliation runs independently. */
let resumeFlight: Promise<void> | null = null
export function resumeElectronSupabaseRealtime(): Promise<void> {
  if (resumeFlight) return resumeFlight
  const client = cachedSupabase, account = currentAccessToken
  if (!client || !account) return Promise.resolve()
  const run = (async () => {
    const release = pauseElectronRealtimeChannels()
    try {
      await client.realtime.disconnect()
      let attempt = 0
      while (cachedSupabase === client && currentAccessToken === account) {
        try {
          // Realtime catches callback errors and reuses its cached JWT. Refresh
          // outside that callback, with normal channel retries held behind us.
          const token = await account(true)
          if (currentAccessToken !== account || !token) return // signed out/replaced
          await client.realtime.setAuth(token)
          release()
          await reconnectElectronRealtimeChannels()
          client.realtime.connect()
          return
        } catch (error) {
          const retryMs = [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(attempt++, 4)]!
          // No token or exception text: upstream errors can carry credentials.
          createLogger('host-resume/auth').warn({ attempt, retryMs, reason: error instanceof Error ? error.name : 'unknown' }, 'Resume ticket renewal will retry')
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, retryMs)
            timer.unref?.()
          })
        }
      }
    } finally { release() }
  })()
  const tracked = run.finally(() => { if (resumeFlight === tracked) resumeFlight = null })
  resumeFlight = tracked
  return tracked
}

let cachedSupabase: ElectronSupabaseClient | null = null
function resolveSupabase(): ElectronSupabaseClient {
  return (cachedSupabase ??= createGuguSupabaseClient({
    accessToken: async () => {
      if (!currentAccessToken) throw new Error('Electron Supabase account provider is not bound')
      return currentAccessToken()
    },
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
