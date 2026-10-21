// @vitest-environment jsdom
// #6723:刷新被限流(429)时,单台客户端的刷新请求必须有上界,会话保留。
// 装配与产品一致:真 supabase-js / auth-js 的 auth 客户端(supabase.ts)+ 真协调器,只把网络换成
// 「/auth/v1/token 一律 429」。修前 mac1 实测:4.5 分钟 43,304 次刷新,且越来越快 —— 两条不退避的路:
// ① supabase-js 收到 SIGNED_OUT 就 realtime.setAuth() → 取令牌走 auth.getSession() → auth-js 从存储里
//   读到那份删不掉的会话(存储适配器 removeItem 为空)→ 再刷 → 429 → 再 SIGNED_OUT,自己转圈;
// ② 协调器把自己那次刷新 / 启动恢复失败带出来的 SIGNED_OUT 当成意外签出,当场再恢复一次,
//   令牌未到期时恢复成功又重置了退避,1 秒后再刷;已过期时恢复与它的重试另起两条退避链。
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}))

const NOW = Date.parse('2026-09-29T00:00:00.000Z')
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (exp: number) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user-a', exp, role: 'authenticated' })}.sig`
const user = { id: 'user-a', aud: 'authenticated', role: 'authenticated', email: 'a@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' }

function persisted(expiresInSeconds: number): Session {
  const exp = Math.floor(NOW / 1000) + expiresInSeconds
  return { access_token: jwt(exp), refresh_token: 'refresh-a', token_type: 'bearer', expires_in: expiresInSeconds, expires_at: exp, user } as Session
}

describe('rate-limited refresh stays bounded (#6723)', () => {
  let refreshPosts: number[] = []
  // 每格都新建一套 auth 客户端 + 协调器;上一格的若不停,会经 auth-js 的 BroadcastChannel('sb-main')
  // 收到这一格的 SIGNED_OUT 去恢复,两套互相点火。
  let stopCoordinator = () => {}

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    refreshPosts = []
    window.localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      await new Promise((resolve) => setTimeout(resolve, 5)) // 一次网络往返,让计时器与请求交错推进
      if (url.includes('/auth/v1/token') && init?.method === 'POST') {
        refreshPosts.push(Date.now() - NOW)
        return new Response(JSON.stringify({ code: 'over_request_rate_limit', error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })
  afterEach(() => {
    stopCoordinator()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function startCoordinator(session: Session) {
    window.localStorage.setItem('sb-main', JSON.stringify(session))
    const { supabase, mainAuthSessionStorage } = await import('../../../../apps/desktop/src/lib/supabase')
    const { SessionCoordinator } = await import('../../../../apps/desktop/src/lib/sessionCoordinator')
    // 与 sessionCoordinator.ts 末尾的产品装配相同的 auth 面;主进程镜像、资料补全、前台信号这些与刷新无关的腿换成桩。
    const coordinator = new SessionCoordinator({
      getSession: () => supabase.auth.getSession(),
      getUser: (accessToken) => supabase.auth.getUser(accessToken),
      refreshSession: (value) => supabase.auth.refreshSession(value),
      restoreSession: (value) => supabase.auth.setSession(value),
      onAuthStateChange: (listener) => supabase.auth.onAuthStateChange((event, value) => listener(event, value)),
      signOut: async () => ({ error: null }),
      hydrateUser: async (value) => ({ id: value.id, email: value.email ?? '', nickname: 'A', bio: null }),
      publishSession: () => {},
      writeMirror: async () => {},
      clearMirror: async () => {},
      getPersistedSessionState: () => mainAuthSessionStorage.getState(),
      commitPersistedSession: (value, signal) => mainAuthSessionStorage.commit(value, signal),
      clearPersistedSession: (value, signal) => mainAuthSessionStorage.remove(value, signal),
      subscribeAppForeground: () => () => {},
    })
    stopCoordinator = coordinator.start()
    return coordinator
  }

  // 修前每秒上百次;先按秒推进,一旦明显失控就停,别让红的那一侧把用例拖成几分钟。
  async function advance(seconds: number) {
    for (let i = 0; i < seconds && refreshPosts.length <= 200; i++) await vi.advanceTimersByTimeAsync(1_000)
  }

  it('the scheduled refresh hitting 429 backs off across expiry and keeps the session', async () => {
    // 到期前 150s 起步:协调器在到期前 120s 排程续期,之后一路 429,直到过期后 60s。
    const coordinator = await startCoordinator(persisted(150))
    await advance(210)

    // 退避 1/2/5/10/30s:210s 里协调器最多续期 10 次;进了 auth-js 的 90s 边界后每次续期它会先自刷一次,
    // 所以每次最多 2 个请求。
    expect(refreshPosts.length).toBeLessThanOrEqual(20)
    expect(coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: { user: { id: 'user-a' } } })
  })

  it('a session already expired at start (restart or wake during the outage) stays bounded', async () => {
    const coordinator = await startCoordinator(persisted(-30))
    await advance(120)

    // 启动恢复按 1/2/5/10/30s 退避:120s 里最多 8 次 getSession,每次遇到过期会话只刷新 1 次。
    expect(refreshPosts.length).toBeLessThanOrEqual(8)
    expect(coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: { user: { id: 'user-a' } } })
  })
})
