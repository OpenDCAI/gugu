// @vitest-environment jsdom
// #6723:一个会话只有一个刷新者(sessionCoordinator),一次到期只发一次刷新请求。
// ① 渲染层的数据请求在令牌临近到期(auth-js 的 EXPIRY_MARGIN_MS = 90s 之内)时不许触发 auth-js 自己的刷新,
//    而是带着协调器已发布的那张令牌发出去。修前:数据请求走主客户端 → getSession → __loadSession →
//    _callRefreshToken,每条数据请求前各打一次 /auth/v1/token。
// ② 协调器按排程刷新的那一刻,auth-js 的 refreshSession 只发一次请求。它内部先 __loadSession,
//    存的会话若已进 90s 边界会先自刷一次,再拿同一个旧 refresh token 刷第二次(服务端只当重放)。
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}))

const PUBLISHED_ACCESS = 'published-access-token'

function nearExpirySession(): Session {
  return {
    access_token: PUBLISHED_ACCESS,
    refresh_token: 'published-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    // 60s 后到期:落在 auth-js 的 90s 刷新边界之内,正是 issue 里「到期前 90s 到 60s」那段窗口。
    expires_at: Math.floor(Date.now() / 1000) + 60,
    user: { id: 'user-a', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
  } as Session
}

type Sent = { url: string; authorization: string | null }

describe('one refresher per session (#6723)', () => {
  const sent: Sent[] = []

  beforeEach(() => {
    vi.resetModules()
    sent.length = 0
    window.localStorage.clear()
    const session = nearExpirySession()
    window.localStorage.setItem('sb-main', JSON.stringify(session))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      sent.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
      if (url.includes('/auth/v1/token')) {
        return new Response(JSON.stringify({ ...session, access_token: 'sdk-refreshed-access', refresh_token: 'sdk-refreshed-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('PostgREST calls from product modules carry the published token and never hit /auth/v1', async () => {
    const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')
    publishRendererSession('SIGNED_IN', nearExpirySession())
    const { getQuotaWindows } = await import('../../../../apps/desktop/src/lib/billing/quota')
    const { fetchMinCriticalCapability } = await import('../../../../apps/desktop/src/lib/runtimeCapabilityPolicy')
    // auth 客户端构造期的 INITIAL_SESSION 加载属于 auth 面(#6731),不是本用例要锁的数据路径:
    // 排在它后面的 getSession 返回时它已做完,之后才开始记账。
    const { supabase } = await import('../../../../apps/desktop/src/lib/supabase')
    await supabase.auth.getSession()
    sent.length = 0

    await getQuotaWindows().catch(() => undefined)
    await fetchMinCriticalCapability()

    // 整张出站清单一起比:修前这里会多出一条 /auth/v1/token,数据请求带的也不再是已发布的令牌。
    expect(sent.map((request) => `${new URL(request.url).pathname} ${request.authorization}`)).toEqual([
      `/rest/v1/rpc/current_quota_windows Bearer ${PUBLISHED_ACCESS}`,
      `/rest/v1/gugu_runtime_capability_policy Bearer ${PUBLISHED_ACCESS}`,
    ])
  })

  it('the coordinator refresh at its scheduled moment sends exactly one refresh request', async () => {
    const { REFRESH_EARLY_MS } = await import('../../../../apps/desktop/src/lib/sessionCoordinator')
    const scheduled = { ...nearExpirySession(), expires_at: Math.floor((Date.now() + REFRESH_EARLY_MS) / 1000) }
    window.localStorage.setItem('sb-main', JSON.stringify(scheduled))
    const { supabase } = await import('../../../../apps/desktop/src/lib/supabase')
    await supabase.auth.getSession()
    sent.length = 0

    // 与协调器 deps.refreshSession 是同一个调用(sessionCoordinator.ts 末尾的依赖装配)。
    await supabase.auth.refreshSession({ refresh_token: scheduled.refresh_token })

    expect(sent.map((request) => `${new URL(request.url).pathname} ${request.authorization}`)).toEqual([
      '/auth/v1/token Bearer test-anon-key',
    ])
  })
})
