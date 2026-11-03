import type { Session } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleLoginFlow, GOOGLE_LOGIN_TIMEOUT_MS, type GoogleLoginDeps } from '../../../../apps/desktop/src/lib/googleLoginFlow'
import { MAIN_PKCE_STORAGE_KEY, OAUTH_PENDING_STORAGE_KEY } from '../../../../apps/desktop/shared/auth-storage-keys'
import { oauthAttemptRedirect, isOAuthAttemptRedirect } from '../../../../apps/desktop/shared/oauth-attempt'
import { googleAuthorizationUrl } from '../../../../apps/desktop/shared/google-authorization-url'
import { createGuguSupabaseClient } from '../../../../packages/core/src/cloud/supabase'

const redirectTo = 'gugu-beta://auth/callback'
const attemptId = '5aa55e8b-f140-4d30-81bb-692d26e17c91'
const callbackUrl = oauthAttemptRedirect(redirectTo, attemptId)
const returned = (code = 'returned') => `${callbackUrl}&code=${code}`
const session = { access_token: 'google-access', refresh_token: 'google-refresh', token_type: 'bearer', expires_in: 3600,
  user: { id: 'existing-email-user', email: 'verified@example.test' } } as Session
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((answer) => { resolve = answer })
  return { promise, resolve }
}
function harness(overrides: Partial<GoogleLoginDeps> = {}) {
  const values = new Map<string, string>()
  const storage = { getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn(async (key: string) => { values.delete(key) }) }
  const deps = {
    storage, redirectTo, newAttemptId: () => attemptId, begin: vi.fn(() => 7), accept: vi.fn(async (_attempt: number, _session: Session) => {}),
    signIn: vi.fn(async () => {
      await storage.setItem(MAIN_PKCE_STORAGE_KEY, JSON.stringify('originating-verifier'))
      return { data: { url: 'https://auth.example.test/auth/v1/authorize?provider=google' }, error: null }
    }),
    exchange: vi.fn(async () => ({ data: { session }, error: null })), openBrowser: vi.fn(async () => {}), ...overrides,
  }
  return { deps, values, flow: new GoogleLoginFlow(deps) }
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Google authorization browser boundary', () => {
  const valid = `https://auth.example.test/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}&code_challenge=challenge&code_challenge_method=s256`
  it('accepts only the configured GoTrue authorization endpoint and callback channel', () => {
    expect(googleAuthorizationUrl(valid, 'https://auth.example.test/', redirectTo)).toBe(valid)
    const nested = valid.replace('https://auth.example.test/', 'https://auth.example.test/supabase/')
    expect(googleAuthorizationUrl(nested, 'https://auth.example.test/supabase', redirectTo)).toBe(nested)
  })
  it('uses one UUID query parameter on the registered callback path', () => {
    expect(isOAuthAttemptRedirect(callbackUrl, redirectTo)).toBe(true)
    expect(isOAuthAttemptRedirect(redirectTo, redirectTo)).toBe(false)
    expect(isOAuthAttemptRedirect(`${callbackUrl}&extra=value`, redirectTo)).toBe(false)
    expect(isOAuthAttemptRedirect(`${callbackUrl}#fragment`, redirectTo)).toBe(false)
    expect(isOAuthAttemptRedirect(callbackUrl.replace('gugu-beta', 'gugu'), redirectTo)).toBe(false)
  })
  it.each([
    valid.replace('auth.example.test', 'evil.example.test'), valid.replace('/authorize', '/logout'),
    valid.replace('provider=google', 'provider=github'), `${valid}&provider=google`, `${valid}&redirect_to=evil`,
    valid.replace('gugu-beta', 'gugu'), valid.replace('&code_challenge=challenge', ''), `${valid}#fragment`,
    valid.replace('https://', 'javascript://'), valid.replace('https://', 'https://user@'),
  ])('rejects an invalid authorization URL before opening an external browser: %s', (raw) => {
    expect(() => googleAuthorizationUrl(raw, 'https://auth.example.test', redirectTo)).toThrow()
  })
})

describe('Google interactive login', () => {
  it('exchanges once, lets a received callback beat browserFinished, and accepts the same canonical user id', async () => {
    const h = harness()
    await h.flow.restore()
    await h.flow.start()
    expect(h.deps.signIn).toHaveBeenCalledExactlyOnceWith(callbackUrl)
    const exchange = deferred<{ data: { session: Session }; error: null }>()
    h.deps.exchange.mockReturnValueOnce(exchange.promise)
    const callback = h.flow.callback(returned())
    h.flow.browserFinished()
    await h.flow.callback(returned())
    expect(h.flow.getSnapshot().phase).toBe('exchanging')
    await vi.waitFor(() => expect(h.deps.exchange).toHaveBeenCalledOnce())
    exchange.resolve({ data: { session }, error: null })
    await callback
    expect(h.deps.accept).toHaveBeenCalledExactlyOnceWith(7, session)
    expect(h.deps.accept.mock.calls[0]![1].user.id).toBe('existing-email-user')
    expect(h.flow.getSnapshot()).toEqual({ phase: 'succeeded', busy: false })
    expect(h.values.size).toBe(0)
  })
  it.each(['button', 'browser', 'provider'] as const)('makes %s cancellation explicit and clears temporary data', async (source) => {
    const h = harness()
    await h.flow.start()
    if (source === 'button') await h.flow.cancel()
    else if (source === 'browser') h.flow.browserFinished()
    else await h.flow.callback(`${callbackUrl}&error=access_denied`)
    await vi.waitFor(() => expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'cancelled', busy: false }))
    await h.flow.callback(returned('late-after-cancel'))
    expect(h.flow.getSnapshot().failure).toBe('cancelled')
    expect(h.deps.exchange).not.toHaveBeenCalled()
    expect(h.deps.accept).not.toHaveBeenCalled()
    expect(h.values.size).toBe(0)
  })
  it('does not accept a late exchange after cancellation and blocks retries until that operation ends', async () => {
    const exchange = deferred<{ data: { session: Session }; error: null }>()
    const h = harness({ exchange: vi.fn(() => exchange.promise) })
    await h.flow.start()
    const pending = h.flow.callback(returned())
    await vi.waitFor(() => expect(h.deps.exchange).toHaveBeenCalledOnce())
    await h.flow.cancel()
    await h.flow.start()
    expect(h.deps.signIn).toHaveBeenCalledOnce()
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'cancelled', busy: true })
    exchange.resolve({ data: { session }, error: null })
    await pending
    expect(h.deps.accept).not.toHaveBeenCalled()
    expect(h.flow.getSnapshot().busy).toBe(false)
    expect(h.values.size).toBe(0)
  })
  it('cleans a verifier generated after cancellation before allowing another attempt', async () => {
    const signIn = deferred<{ data: { url: string }; error: null }>()
    const h = harness({ signIn: vi.fn(() => signIn.promise) })
    const pending = h.flow.start()
    await vi.waitFor(() => expect(h.deps.signIn).toHaveBeenCalledOnce())
    await h.flow.cancel()
    await h.flow.start()
    h.values.set(MAIN_PKCE_STORAGE_KEY, 'late-verifier')
    signIn.resolve({ data: { url: 'https://auth.example.test' }, error: null })
    await pending
    expect(h.deps.signIn).toHaveBeenCalledOnce()
    expect(h.deps.openBrowser).not.toHaveBeenCalled()
    expect(h.values.size).toBe(0)
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'cancelled', busy: false })
  })
  it('checks elapsed wall time even if native background timers did not run', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.flow.start()
    vi.setSystemTime(Date.now() + GOOGLE_LOGIN_TIMEOUT_MS)
    await h.flow.callback(returned('late'))
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'timeout', busy: false })
    expect(h.deps.exchange).not.toHaveBeenCalled()
  })
  it('restores a native persisted attempt with its original deadline after a process restart', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.values.set(MAIN_PKCE_STORAGE_KEY, 'persisted')
    h.values.set(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: attemptId, phase: 'authorizing', expiresAt: Date.now() + 1000 }))
    await h.flow.restore()
    expect(h.flow.getSnapshot().phase).toBe('authorizing')
    expect(h.deps.begin).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'timeout', busy: false })
    expect(h.values.size).toBe(0)
  })
  it('resumes the persisted verifier and exchanges a cold callback without opening another browser', async () => {
    const h = harness()
    h.values.set(MAIN_PKCE_STORAGE_KEY, 'persisted')
    h.values.set(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: attemptId, phase: 'authorizing', expiresAt: Date.now() + 60_000 }))
    await h.flow.restore()
    await h.flow.callback(returned('cold'))
    expect(h.deps.accept).toHaveBeenCalledExactlyOnceWith(7, session)
    expect(h.deps.openBrowser).not.toHaveBeenCalled()
  })
  it('rejects an older attempt without exchanging or terminating the current attempt', async () => {
    const nextId = '92967f1c-6d19-4d92-a2d0-e38caf7377b7'
    const h = harness({ newAttemptId: vi.fn().mockReturnValueOnce(attemptId).mockReturnValueOnce(nextId) })
    await h.flow.start()
    await h.flow.cancel()
    await h.flow.start()
    const currentPending = h.values.get(OAUTH_PENDING_STORAGE_KEY)
    await h.flow.callback(returned('earlier-attempt'))
    expect(h.flow.getSnapshot()).toEqual({ phase: 'authorizing', busy: true, notice: 'staleCallback' })
    expect(h.deps.exchange).not.toHaveBeenCalled()
    expect(h.values.get(OAUTH_PENDING_STORAGE_KEY)).toBe(currentPending)
    expect(h.values.has(MAIN_PKCE_STORAGE_KEY)).toBe(true)
    await h.flow.callback(`${oauthAttemptRedirect(redirectTo, nextId)}&code=current`)
    expect(h.deps.exchange).toHaveBeenCalledExactlyOnceWith('current')
    expect(h.flow.getSnapshot().phase).toBe('succeeded')
    expect(h.values.size).toBe(0)
  })
  it('does not resubmit a code claimed by an interrupted process', async () => {
    const h = harness()
    h.values.set(MAIN_PKCE_STORAGE_KEY, 'persisted')
    h.values.set(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: attemptId, phase: 'exchanging', expiresAt: Date.now() + 60_000 }))
    await h.flow.restore()
    await h.flow.callback(returned('already-claimed'))
    expect(h.deps.exchange).not.toHaveBeenCalled()
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'invalidCode', busy: false })
    expect(h.values.size).toBe(0)
  })
  it.each(['bad_code_verifier', 'flow_state_expired', 'flow_state_not_found', 'invalid_grant', 'pkce_code_verifier_not_found'])('reports %s as invalid/expired authorization', async (code) => {
    const h = harness({ exchange: vi.fn(async () => ({ data: { session: null }, error: { code } })) })
    await h.flow.start()
    await h.flow.callback(returned('wrong'))
    expect(h.flow.getSnapshot()).toEqual({ phase: 'failed', failure: 'invalidCode', busy: false })
    expect(h.deps.accept).not.toHaveBeenCalled()
    expect(h.values.size).toBe(0)
  })
  it('rejects unsolicited callbacks and wrong channels without exchanging', async () => {
    const h = harness()
    await h.flow.callback(returned('unsolicited'))
    expect(h.flow.getSnapshot().phase).toBe('idle')
    await h.flow.start()
    await h.flow.callback('gugu://auth/callback?code=wrong-channel')
    expect(h.flow.getSnapshot().notice).toBe('staleCallback')
    await h.flow.cancel()
    expect(h.deps.exchange).not.toHaveBeenCalled()
  })
  it('reports missing verifier, network, provider, browser, and storage failures', async () => {
    const missing = harness()
    await missing.flow.start()
    missing.values.delete(MAIN_PKCE_STORAGE_KEY)
    await missing.flow.callback(returned())
    expect(missing.flow.getSnapshot().failure).toBe('invalidCode')
    const network = harness({ exchange: vi.fn(async () => ({ data: { session: null }, error: new TypeError('Failed to fetch') })) })
    await network.flow.start()
    await network.flow.callback(returned())
    expect(network.flow.getSnapshot().failure).toBe('exchange')
    const provider = harness({ signIn: vi.fn(async () => ({ data: { url: null }, error: new Error('Provider unavailable') })) })
    await provider.flow.start()
    expect(provider.flow.getSnapshot().failure).toBe('provider')
    const browser = harness({ openBrowser: vi.fn(async () => { throw new Error('Browser unavailable') }) })
    await browser.flow.start()
    expect(browser.flow.getSnapshot().failure).toBe('browser')
    const storage = harness()
    storage.deps.storage.setItem.mockRejectedValueOnce(new Error('Native write rejected'))
    await storage.flow.start()
    expect(storage.flow.getSnapshot().failure).toBe('storage')
  })
  it('cannot publish a session if clearing native temporary data fails', async () => {
    const h = harness()
    await h.flow.start()
    h.deps.storage.removeItem.mockRejectedValueOnce(new Error('Native removal failed'))
    await h.flow.callback(returned())
    expect(h.flow.getSnapshot().failure).toBe('storage')
    expect(h.deps.accept).not.toHaveBeenCalled()
    expect(h.deps.storage.removeItem).toHaveBeenCalledWith(MAIN_PKCE_STORAGE_KEY)
    expect(h.values.size).toBe(0)
  })
  it.each(['success', 'cancelled', 'expired'] as const)('clears both temporary keys with the actual auth-js client on %s', async (outcome) => {
    const h = harness()
    const fetch = vi.fn(async () => new Response(JSON.stringify(outcome === 'expired'
      ? { error_code: 'flow_state_expired', msg: 'Flow expired' } : session), {
      status: outcome === 'expired' ? 400 : 200, headers: { 'Content-Type': 'application/json' },
    }))
    const client = createGuguSupabaseClient({ url: 'https://auth.example.test', anonKey: 'public-test-key',
      storageKey: 'sb-main', persistSession: true, autoRefreshToken: false, flowType: 'pkce', fetch,
      storage: { getItem: h.deps.storage.getItem,
        setItem: async (key, value) => { if (key === MAIN_PKCE_STORAGE_KEY) await h.deps.storage.setItem(key, value) },
        removeItem: async (key) => { if (key === MAIN_PKCE_STORAGE_KEY) await h.deps.storage.removeItem(key) },
      },
    })
    const flow = new GoogleLoginFlow({ ...h.deps,
      signIn: (url) => client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: url, skipBrowserRedirect: true } }),
      exchange: (code) => client.auth.exchangeCodeForSession(code),
    })
    try {
      await flow.start()
      expect(h.values.has(MAIN_PKCE_STORAGE_KEY)).toBe(true)
      expect(h.values.has(OAUTH_PENDING_STORAGE_KEY)).toBe(true)
      if (outcome === 'cancelled') await flow.cancel()
      else await flow.callback(returned())
      expect(flow.getSnapshot()).toMatchObject(outcome === 'success'
        ? { phase: 'succeeded', busy: false }
        : { phase: 'failed', failure: outcome === 'expired' ? 'invalidCode' : 'cancelled', busy: false })
      expect(h.values.size).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(outcome === 'cancelled' ? 0 : 1)
      if (outcome === 'success') expect(h.deps.accept).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({ user: session.user }))
      else expect(h.deps.accept).not.toHaveBeenCalled()
    } finally { await client.auth.stopAutoRefresh() }
  })
})
