// @vitest-environment jsdom
// #6338:服务端不认登录通行证(换签名章 / 提前作废)时,App 要立刻换新证,而不是卡到通行证自然到期。
import type { Session, User } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authBoundedFetch, setRejectedAccessTokenRecovery } from '../../../../apps/desktop/src/lib/authBoundedFetch'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'
import type { AuthUser } from '../../../../apps/desktop/src/store/auth'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function jwt(claims: Record<string, string>): string {
  const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${b64({ alg: 'ES256' })}.${b64(claims)}.sig`
}
const tok = (tag: string, sub = 'user-a') => jwt({ role: 'authenticated', sub, tag })

function session(access: string, refresh = `refresh-${access}`, id = 'user-a'): Session {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: 'a@example.test',
      user_metadata: {}, app_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
  } as Session
}
const profile = (id: string): AuthUser => ({ id, email: `${id}@example.test`, nickname: `Canonical ${id}`, bio: null })

function coordinator(overrides: Partial<SessionCoordinatorDeps> = {}) {
  let authListener: (event: string, value: Session | null) => void = () => {}
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async (token?: string) => {
      const sub = (JSON.parse(atob((token ?? '').split('.')[1] ?? 'e30')) as { sub?: string }).sub ?? 'user-a'
      return { data: { user: session(tok('x', sub), 'r', sub).user }, error: null }
    }),
    refreshSession: vi.fn(async () => ({ data: { session: session(tok('new')) }, error: null })),
    restoreSession: vi.fn(async ({ access_token }) => ({ data: { session: session(access_token) }, error: null })),
    onAuthStateChange: vi.fn((listener) => { authListener = listener; return { data: { subscription: { unsubscribe: vi.fn() } } } }),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user: User) => profile(user.id)),
    publishSession: vi.fn(),
    writeMirror: vi.fn(async () => {}),
    clearMirror: vi.fn(async () => {}),
    getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}),
    clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: vi.fn(() => () => {}),
    ...overrides,
  }
  const c = new SessionCoordinator(deps)
  return { c, deps, fire: (event: string, value: Session | null) => authListener(event, value) }
}

describe('SessionCoordinator.recoverRejectedAccessToken (#6338)', () => {
  it('swaps a rejected token once for concurrent callers and hands out the new one', async () => {
    const h = coordinator()
    h.c.start()
    await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('old'), 'refresh-old'))
    const [a, b] = await Promise.all([
      h.c.recoverRejectedAccessToken(tok('old')),
      h.c.recoverRejectedAccessToken(tok('old')),
    ])
    expect(a).toBe(tok('new'))
    expect(b).toBe(tok('new'))
    expect(h.deps.refreshSession).toHaveBeenCalledTimes(1)
    expect(h.deps.refreshSession).toHaveBeenCalledWith({ refresh_token: 'refresh-old' })
  })

  it('does not refresh again when another request already rotated the token', async () => {
    const h = coordinator()
    h.c.start()
    await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('current')))
    expect(await h.c.recoverRejectedAccessToken(tok('stale'))).toBe(tok('current'))
    expect(h.deps.refreshSession).not.toHaveBeenCalled()
  })

  it('never hands another account\'s token to a request started by the previous account', async () => {
    const h = coordinator()
    h.c.start()
    await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('b', 'user-b'), 'refresh-b', 'user-b'))
    expect(await h.c.recoverRejectedAccessToken(tok('a-old', 'user-a'))).toBeNull()
    expect(h.deps.refreshSession).not.toHaveBeenCalled()
  })

  it('drops the swap when the account changes while the refresh is in flight', async () => {
    let finishRefresh: (value: { data: { session: Session | null }; error: unknown }) => void = () => {}
    const h = coordinator({
      refreshSession: vi.fn<SessionCoordinatorDeps['refreshSession']>(() => new Promise((resolve) => { finishRefresh = resolve })),
    })
    h.c.start()
    await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('a-old'), 'refresh-a'))
    const recovering = h.c.recoverRejectedAccessToken(tok('a-old'))
    await flush()
    await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('b', 'user-b'), 'refresh-b', 'user-b'))
    finishRefresh({ data: { session: session(tok('a-new'), 'refresh-a2') }, error: null })
    expect(await recovering).toBeNull()
    expect(h.c.getSnapshot().session?.user.id).toBe('user-b')
  })

  it('does not start a refresh storm when the freshly swapped token is rejected too', async () => {
    const getUser = vi.fn<SessionCoordinatorDeps['getUser']>(async () =>
      ({ data: { user: null }, error: Object.assign(new Error('invalid JWT'), { code: 'bad_jwt', status: 403 }) }))
    const h = coordinator({ getUser })
    const dispose = h.c.start()
    h.fire('INITIAL_SESSION', session(tok('old')))
    await flush(); await flush(); await flush(); await flush()
    expect(h.deps.refreshSession).toHaveBeenCalledTimes(1)
    expect(h.c.getSnapshot()).toMatchObject({ status: 'degraded', session: { access_token: tok('new') } })
    dispose()
  })

  it('startup validation that meets bad_jwt refreshes instead of retrying the same token forever', async () => {
    const getUser = vi.fn<SessionCoordinatorDeps['getUser']>(async (token) =>
      token === tok('old')
        ? { data: { user: null }, error: Object.assign(new Error('invalid JWT'), { code: 'bad_jwt', status: 403 }) }
        : { data: { user: session(token as string).user }, error: null })
    const h = coordinator({ getUser })
    h.c.start()
    h.fire('INITIAL_SESSION', session(tok('old')))
    await flush(); await flush(); await flush()
    expect(h.deps.refreshSession).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenLastCalledWith(tok('new'))
    expect(h.c.getSnapshot()).toMatchObject({ status: 'authenticated', session: { access_token: tok('new') }, user: { nickname: 'Canonical user-a' } })
  })

  it('while refresh is backing off after a failure (429), rejected requests do not refresh again', async () => {
    vi.useFakeTimers()
    try {
      const refreshSession = vi.fn<SessionCoordinatorDeps['refreshSession']>(async () =>
        ({ data: { session: null }, error: Object.assign(new Error('Request rate limit reached'), { status: 429, code: 'over_request_rate_limit' }) }))
      const h = coordinator({ refreshSession })
      h.c.start()
      await h.c.acceptInteractiveSession(h.c.beginInteractiveLogin(), session(tok('old')))
      expect(await h.c.recoverRejectedAccessToken(tok('old'))).toBeNull()
      expect(refreshSession).toHaveBeenCalledTimes(1)
      // 退避期间(第一档 1 s 之内)又来 5 条被拒的数据请求:一次都不另起。
      for (let i = 0; i < 5; i++) expect(await h.c.recoverRejectedAccessToken(tok('old'))).toBeNull()
      expect(refreshSession).toHaveBeenCalledTimes(1)
      // 协调器自己的重试照常到点。
      await vi.advanceTimersByTimeAsync(1_000)
      expect(refreshSession).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('authBoundedFetch rejected-token retry (#6338)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  afterEach(() => { setRejectedAccessTokenRecovery(null); fetchMock.mockReset(); vi.unstubAllGlobals() })

  const oldUser = tok('old')
  const newUser = tok('new')
  const anon = jwt({ role: 'anon' })
  const call = (token: string, url = 'https://db.example/rest/v1/chat_members?select=*') =>
    authBoundedFetch(url, { method: 'GET', headers: { apikey: anon, Authorization: `Bearer ${token}` } })
  const sentAuth = (n: number) => new Headers(fetchMock.mock.calls[n][1]?.headers).get('Authorization')

  it('re-sends a data request once with the swapped token after a 401', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(new Response('{"code":"PGRST301"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const recovery = vi.fn(async () => newUser)
    setRejectedAccessTokenRecovery(recovery)
    const response = await call(oldUser)
    expect(response.status).toBe(200)
    expect(recovery).toHaveBeenCalledWith(oldUser)
    expect(sentAuth(1)).toBe(`Bearer ${newUser}`)
  })

  it('retries at most once: a second 401 goes back to the caller', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    setRejectedAccessTokenRecovery(vi.fn(async () => newUser))
    expect((await call(oldUser)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never swaps when the rejected credential is the anon key', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const recovery = vi.fn(async () => newUser)
    setRejectedAccessTokenRecovery(recovery)
    expect((await call(anon)).status).toBe(401)
    expect(recovery).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats storage 400 with a JWT complaint as rejected, but not an unrelated 400', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(new Response('{"message":"invalid signature"}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"message":"bucket not found"}', { status: 400 }))
    setRejectedAccessTokenRecovery(vi.fn(async () => newUser))
    expect((await call(oldUser, 'https://db.example/storage/v1/object/list/a')).status).toBe(200)
    expect((await call(oldUser, 'https://db.example/storage/v1/object/list/b')).status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
