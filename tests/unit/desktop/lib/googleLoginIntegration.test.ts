// @vitest-environment jsdom
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MAIN_PKCE_STORAGE_KEY, OAUTH_PENDING_STORAGE_KEY } from '../../../../apps/desktop/shared/auth-storage-keys'

const m = vi.hoisted(() => ({
  authenticated: vi.fn(), session: null as Session | null, status: 'anonymous', coordinatorSubscribe: vi.fn((_listener: () => void) => () => {}),
  sourceReady: vi.fn(async () => {}), redirectTo: vi.fn(async () => 'gugu-beta://auth/callback'), subscribe: vi.fn(),
  browserSubscribe: vi.fn(async () => () => {}), openBrowser: vi.fn(async (_url: string) => {}),
  persistent: false, requestOtp: vi.fn(async (_email: string) => ({ success: false, error: 'fixture send failure' })),
  values: new Map<string, string>(), signIn: vi.fn(), exchange: vi.fn(),
  begin: vi.fn(() => 17), accept: vi.fn(async (_attempt: number, _session: Session) => {}), referrer: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { authCallbacks: {}, oauthBrowser: { openBrowser: m.openBrowser, subscribeBrowserFinished: m.browserSubscribe } } }))
vi.mock('../../../../apps/desktop/src/lib/authCallbacks', () => ({ authCallbacks: { ready: m.sourceReady, redirectTo: m.redirectTo, subscribe: m.subscribe, setAuthenticated: m.authenticated } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  mainAuthTemporaryStorage: {
    getItem: async (key: string) => m.persistent ? localStorage.getItem(key) : m.values.get(key) ?? null,
    setItem: async (key: string, value: string) => { if (m.persistent) localStorage.setItem(key, value); else m.values.set(key, value) },
    removeItem: async (key: string) => { if (m.persistent) localStorage.removeItem(key); else m.values.delete(key) },
  },
  supabase: { auth: { signInWithOAuth: m.signIn, exchangeCodeForSession: m.exchange } },
}))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: m.begin, acceptInteractiveSession: m.accept, getSnapshot: () => ({ status: m.status, session: m.session }), subscribe: m.coordinatorSubscribe } }))
vi.mock('../../../../apps/desktop/src/lib/referral', () => ({ clearPendingReferrer: m.referrer }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.example.test', getSupabaseAnonKey: () => 'public-test-key' }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: { requestLoginOtp: m.requestOtp } }))
vi.mock('../../../../apps/desktop/src/pages/login/AuthBrandMotion', () => ({ AuthBrandMotion: () => null }))
vi.mock('../../../../apps/desktop/src/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  m.persistent = false
  localStorage.removeItem(MAIN_PKCE_STORAGE_KEY)
  localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY)
  m.values.clear()
  m.session = null
  m.status = 'anonymous'
  m.sourceReady.mockResolvedValue()
  m.browserSubscribe.mockResolvedValue(() => {})
  m.subscribe.mockReturnValue(() => {})
  m.signIn.mockImplementation(async ({ options }: { options: { redirectTo: string } }) => {
    m.values.set('sb-main-code-verifier', JSON.stringify('native-verifier'))
    return { data: { url: `https://auth.example.test/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(options.redirectTo)}&code_challenge=challenge` }, error: null }
  })
})

it('waits for both native subscriptions, then exchanges into the existing coordinator without creating an identity', async () => {
  let sourceReady!: () => void, browserReady!: (stop: () => void) => void
  m.sourceReady.mockReturnValueOnce(new Promise<void>((resolve) => { sourceReady = resolve }))
  m.browserSubscribe.mockReturnValueOnce(new Promise<() => void>((resolve) => { browserReady = resolve }))
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  const starting = googleLogin.start()
  expect(m.signIn).not.toHaveBeenCalled()
  sourceReady()
  await vi.waitFor(() => expect(m.browserSubscribe).toHaveBeenCalledOnce())
  expect(m.signIn).not.toHaveBeenCalled()
  browserReady(() => {})
  await starting
  expect(m.signIn).toHaveBeenCalledExactlyOnceWith({ provider: 'google', options: { redirectTo: expect.stringContaining('https://gugu.nextmind.space/zh/auth/callback/?scheme=gugu-beta&gugu_oauth_attempt='), skipBrowserRedirect: true } })
  expect(m.openBrowser).toHaveBeenCalledOnce()
  expect(new URL(m.openBrowser.mock.calls[0]![0]).searchParams.get('redirect_to')).toBe(m.signIn.mock.calls[0]![0].options.redirectTo)
  const session = { user: { id: 'existing-email-user' }, access_token: 'access', refresh_token: 'refresh' } as Session
  m.exchange.mockResolvedValueOnce({ data: { session }, error: null })
  const incoming = m.subscribe.mock.calls[0]![0] as (url: string) => void
  const handoff = new URL(m.signIn.mock.calls[0]![0].options.redirectTo)
  incoming(`gugu-beta://auth/callback?gugu_oauth_attempt=${handoff.searchParams.get('gugu_oauth_attempt')}&code=returned`)
  await vi.waitFor(() => expect(googleLogin.getSnapshot().phase).toBe('succeeded'))
  expect(m.exchange).toHaveBeenCalledExactlyOnceWith('returned')
  expect(m.begin).toHaveBeenCalledOnce()
  expect(m.accept).toHaveBeenCalledExactlyOnceWith(17, session)
  expect(m.referrer).toHaveBeenCalledOnce()
  expect(m.values.has(MAIN_PKCE_STORAGE_KEY)).toBe(false)
})

it('does not begin authorization if browser-close registration fails', async () => {
  m.browserSubscribe.mockRejectedValueOnce(new Error('Browser listener denied'))
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  await googleLogin.start()
  expect(googleLogin.getSnapshot()).toEqual({ phase: 'failed', failure: 'callbackUnavailable', busy: false })
  expect(m.signIn).not.toHaveBeenCalled()
  expect(m.openBrowser).not.toHaveBeenCalled()
})

it('waits for session restoration and drops stale OAuth state when an existing account is restored', async () => {
  let decided!: () => void
  const stop = vi.fn()
  m.status = 'boot-restoring'
  m.coordinatorSubscribe.mockImplementationOnce((listener: () => void) => { decided = listener; return stop })
  m.values.set('sb-main-oauth-pending', 'stale-pending')
  m.values.set(MAIN_PKCE_STORAGE_KEY, 'stale-verifier')
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  const starting = googleLogin.start()
  await vi.waitFor(() => expect(m.coordinatorSubscribe).toHaveBeenCalledOnce())
  expect(m.sourceReady).not.toHaveBeenCalled()
  m.status = 'ready'
  m.session = { user: { id: 'already-signed-in' } } as Session
  decided()
  await starting
  expect(m.authenticated).toHaveBeenCalledExactlyOnceWith(true)
  expect(m.values.size).toBe(0)
  expect(m.browserSubscribe).not.toHaveBeenCalled()
  expect(m.signIn).not.toHaveBeenCalled()
  expect(m.exchange).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledOnce()
  m.session = null
  m.status = 'anonymous'
  await googleLogin.start()
  expect(m.sourceReady).toHaveBeenCalledTimes(2)
  expect(m.browserSubscribe).toHaveBeenCalledOnce()
  expect(m.subscribe).toHaveBeenCalledOnce()
  expect(m.signIn).toHaveBeenCalledOnce()
  await googleLogin.cancel()
})

it('keeps authorization closed after a callback source failure and checks readiness on retry', async () => {
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  googleLogin.initialize()
  expect(googleLogin.getSnapshot()).toEqual({ phase: 'restoring', busy: true })
  await vi.waitFor(() => expect(m.subscribe).toHaveBeenCalledOnce())
  m.sourceReady.mockRejectedValueOnce(new Error('Native callback delivery failed'))
  await googleLogin.start()
  await vi.waitFor(() => expect(googleLogin.getSnapshot()).toEqual({ phase: 'failed', failure: 'callbackUnavailable', busy: false }))
  expect(m.signIn).not.toHaveBeenCalled()
  await googleLogin.start()
  expect(m.signIn).toHaveBeenCalledOnce()
  await googleLogin.cancel()
})

it('keeps the current state when App initializes an already prepared flow again', async () => {
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  googleLogin.initialize()
  await vi.waitFor(() => expect(googleLogin.getSnapshot().phase).toBe('idle'))
  googleLogin.initialize()
  await vi.waitFor(() => expect(googleLogin.getSnapshot()).toEqual({ phase: 'idle', busy: false }))
  expect(m.browserSubscribe).toHaveBeenCalledOnce()
  expect(m.subscribe).toHaveBeenCalledOnce()
})


it.each(['off', 'error', 'timeout'] as const)('can cancel a real persisted authorization and return to email when settings is %s', async (mode) => {
  vi.useFakeTimers()
  m.persistent = true
  localStorage.setItem(MAIN_PKCE_STORAGE_KEY, JSON.stringify('originating-verifier'))
  localStorage.setItem(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: '5aa55e8b-f140-4d30-81bb-692d26e17c91', phase: 'authorizing', expiresAt: Date.now() + 300_000 }))
  vi.stubGlobal('fetch', async () => mode === 'timeout' ? new Promise<Response>(() => {})
    : Response.json({ external: { google: false } }, { status: mode === 'error' ? 503 : 200 }))
  const { googleLogin } = await import('../../../../apps/desktop/src/lib/googleLogin')
  googleLogin.initialize()
  await vi.waitFor(() => expect(googleLogin.getSnapshot().phase).toBe('authorizing'))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { i18n } = await import('../../../../apps/desktop/src/i18n')
  await import('../../../../apps/desktop/src/i18n/registerMainCatalog')
  await i18n.changeLanguage('zh-CN')
  const { LoginPage } = await import('../../../../apps/desktop/src/pages/LoginPage')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  try {
    await act(async () => { root.render(createElement(LoginPage)) })
    if (mode === 'timeout') await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '取消 Google 登录')
    expect(cancel).toBeDefined()
    expect(cancel!.disabled).toBe(false)
    expect(host.querySelector('.gugu-auth-divider')).toBeNull()
    const input = host.querySelector<HTMLInputElement>('input[type="email"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'verified@example.test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    await act(async () => { cancel!.click() })
    expect(googleLogin.getSnapshot()).toEqual({ phase: 'failed', failure: 'cancelled', busy: false })
    expect(localStorage.getItem(MAIN_PKCE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(OAUTH_PENDING_STORAGE_KEY)).toBeNull()
    expect(submit.disabled).toBe(false)
    await act(async () => { submit.click() })
    expect(m.requestOtp).toHaveBeenCalledExactlyOnceWith('verified@example.test')
    expect(m.signIn).not.toHaveBeenCalled()
  } finally {
    await act(async () => { await googleLogin.cancel(); root.unmount() })
    host.remove()
  }
})
