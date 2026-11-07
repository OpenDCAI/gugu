// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, User } from '@supabase/supabase-js'
import { OAUTH_ATTEMPT_PARAM } from '../../../../apps/desktop/shared/oauth-attempt'

const m = vi.hoisted(() => ({
  user: null as User | null, session: null as Session | null, returned: null as User | null,
  callback: null as ((url: string) => void) | null,
  deferCallback: false,
  accountOnly: false,
  fetch: vi.fn(), open: vi.fn(), openLink: vi.fn(), accept: vi.fn(), logout: vi.fn(), update: vi.fn(),
}))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.example.test', getSupabaseAnonKey: () => 'public-anon-key' }))
vi.mock('../../../../apps/desktop/src/lib/authBoundedFetch', () => ({ authBoundedFetch: (...args: unknown[]) => m.fetch(...args) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ supabase: { auth: {
  getUser: async () => ({ data: { user: m.user }, error: null }),
  updateUser: (...args: unknown[]) => m.update(...args),
  unlinkIdentity: async () => { m.user = { ...m.user!, identities: m.user!.identities?.filter(identity => identity.provider !== 'google') }; return { error: null } },
} } }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {
  getSnapshot: () => ({ session: m.session }), refresh: async () => {}, beginInteractiveLogin: () => 1,
  acceptInteractiveSession: (...args: unknown[]) => m.accept(...args), logout: () => m.logout(),
} }))
vi.mock('../../../../apps/desktop/src/lib/authLogout', () => ({ logoutAndRelaunch: async (onSignedOut?: () => void) => {
  const result = await m.logout()
  if (result.success) onSignedOut?.()
  return result
} }))
vi.mock('../../../../apps/desktop/src/lib/authCallbacks', () => ({ authCallbacks: {
  ready: async () => {}, redirectTo: async () => 'gugu-dev://auth/callback',
  subscribeAccount: (callback: (url: string) => void) => { m.callback = callback; return () => { m.callback = null } },
} }))
vi.mock('../../../../apps/desktop/src/platform', () => {
  const browser = { openBrowser: (...args: unknown[]) => m.open(...args), openLinkBrowser: (...args: unknown[]) => m.openLink(...args) }
  return { platform: { authCallbacks: {}, get oauthBrowser() { return m.accountOnly ? undefined : browser },
    get accountOAuthBrowser() { return m.accountOnly ? browser : undefined } } }
})

function user(id = 'alice', google = false): User {
  return { id, email: `${id}@example.test`, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '',
    identities: [...(google ? [{ id: 'google-subject', identity_id: 'identity-id', provider: 'google', user_id: id, created_at: '', updated_at: '', identity_data: { email: 'google@example.test' } }] : []), { id, identity_id: `email-${id}`, provider: 'email', user_id: id, created_at: '', updated_at: '', identity_data: { email: `${id}@example.test` } }] }
}
function session(value: User): Session {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: value.id, exp, iat: exp - 3600 }))}.signature`
  return { access_token: token, refresh_token: `refresh-${value.id}`, token_type: 'bearer', expires_in: 3600, expires_at: exp, user: value }
}
function send(callbackUrl: string): void {
  if (m.deferCallback) return
  const attempt = new URL(callbackUrl).searchParams.get(OAUTH_ATTEMPT_PARAM)
  queueMicrotask(() => m.callback?.(`gugu-dev://auth/callback?${OAUTH_ATTEMPT_PARAM}=${attempt}&code=returned-code`))
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  window.localStorage.clear()
  m.user = user(); m.session = session(m.user); m.returned = null; m.callback = null; m.deferCallback = false; m.accountOnly = false
  m.update.mockImplementation(async (attrs: { data?: Record<string, unknown> }) => {
    m.user = { ...m.user!, user_metadata: { ...m.user!.user_metadata, ...attrs.data } }
    return { data: { user: m.user }, error: null }
  })
  m.logout.mockResolvedValue({ success: true })
  m.fetch.mockImplementation(async (raw: string, init: RequestInit) => {
    const url = new URL(raw)
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 })
    if (url.pathname.endsWith('/user') && init.method === 'PUT') {
      const attrs = JSON.parse(init.body as string)
      m.update(attrs)
      return Response.json(m.user)
    }
    if (url.pathname.includes('/user/identities/') && init.method === 'DELETE') {
      m.user = { ...m.user!, identities: m.user!.identities?.filter(identity => identity.provider !== 'google') }
      return Response.json({})
    }
    if (url.pathname.endsWith('/token') || url.pathname.endsWith('/verify')) {
      return Response.json(session(m.returned ?? m.user!))
    }
    if (url.pathname.endsWith('/user/identities/authorize')) {
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${m.session!.access_token}` })
      expect(url.searchParams.get('code_challenge')).toBeTruthy()
      const callbackUrl = url.searchParams.get('redirect_to')!
      return Response.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=state&response_type=code&redirect_uri=https%3A%2F%2Fauth.example.test%2Fauth%2Fv1%2Fcallback&gugu_test_callback=${encodeURIComponent(callbackUrl)}` })
    }
    if (url.pathname.endsWith('/otp')) return Response.json({})
    throw new Error(`Unexpected test request ${url.pathname}`)
  })
  m.open.mockImplementation(async (raw: string) => { send(new URL(raw).searchParams.get('redirect_to')!) })
  m.openLink.mockImplementation(async (_raw: string, callbackUrl: string) => { m.user = user('alice', true); send(callbackUrl) })
})

describe('account linking adapter with the real auth SDK', () => {
  it('verifies email in an isolated session and revokes only that temporary session', async () => {
    const original = m.session
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.requestVerification(); await flow.verifyEmail('123456')
    const otp = m.fetch.mock.calls.find(([url]) => String(url).endsWith('/otp'))!
    expect(JSON.parse(otp[1].body)).toMatchObject({ email: 'alice@example.test', create_user: false })
    expect(m.fetch.mock.calls.some(([url]) => String(url).endsWith('/logout?scope=local'))).toBe(true)
    expect(m.session).toBe(original)
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.logout).not.toHaveBeenCalled()
  })
  it('does not replace the current login when Google returns another account', async () => {
    m.user = user('alice', true); m.session = session(m.user); m.returned = user('bob', true)
    const original = m.session
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    await expect(createAccountLinking('alice').verifyGoogle()).rejects.toMatchObject({ code: 'ownerChanged' })
    expect(m.session).toBe(original)
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.logout).not.toHaveBeenCalled()
    expect(m.fetch.mock.calls.some(([url]) => String(url).endsWith('/logout?scope=local'))).toBe(true)
    expect(m.callback).toBeNull()
  })
  it.each([false, true])('links a different Google address with the original bearer, account-only browser: %s', async accountOnly => {
    m.accountOnly = accountOnly
    const original = m.session
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyEmail('123456')
    await expect(flow.linkGoogle()).resolves.toBe(true)
    expect(m.user!.identities?.find(identity => identity.provider === 'google')?.identity_data?.email).toBe('google@example.test')
    expect(m.session).toBe(original)
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.openLink).toHaveBeenCalledOnce()
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { gugu_login_method_change: expect.objectContaining({ kind: 'google-linked' }) } }))
  })
  it('cancels authorization and ignores a late callback without replacing the session', async () => {
    m.user = user('alice', true); m.session = session(m.user); m.deferCallback = true
    const { createAccountLinking, cancelAccountGoogle } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const pending = createAccountLinking('alice').verifyGoogle()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'googleCancelled' })
    await vi.waitFor(() => expect(m.open).toHaveBeenCalledOnce())
    const callback = m.callback!
    await cancelAccountGoogle(); await rejected
    callback('gugu-dev://auth/callback?code=late')
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.fetch.mock.calls.some(([url]) => String(url).includes('/token'))).toBe(false)
  })
  it('uses global revocation only for unlinking, then lets the coordinator clear the local session', async () => {
    m.user = user('alice', true); m.session = session(m.user)
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyGoogle(); await flow.unlinkGoogle()
    expect(m.fetch.mock.calls.some(([url]) => String(url).endsWith('/logout?scope=global'))).toBe(true)
    expect(m.logout).toHaveBeenCalledOnce()
    expect(m.accept).not.toHaveBeenCalled()
  })
  it('does not log out a new account when a previous account global-revocation response arrives late', async () => {
    m.user = user('alice', true); m.session = session(m.user)
    const originalFetch = m.fetch.getMockImplementation()!
    m.fetch.mockImplementation(async (raw: string, init: RequestInit) => {
      const response = await originalFetch(raw, init)
      if (raw.endsWith('/logout?scope=global')) m.session = session(user('bob'))
      return response
    })
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyGoogle()
    await expect(flow.unlinkGoogle()).resolves.toBeUndefined()
    expect(m.logout).not.toHaveBeenCalled()
    expect(m.session.user.id).toBe('bob')
  })
  it('restores local cleanup after reopening settings without repeating a successful global revocation', async () => {
    m.user = user('alice', true); m.session = session(m.user)
    m.logout.mockRejectedValueOnce(new Error('local storage unavailable'))
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyGoogle()
    await expect(flow.unlinkGoogle()).rejects.toThrow('local storage unavailable')
    flow.dispose()
    vi.resetModules()
    const reopened = (await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')).createAccountLinking('alice')
    expect(reopened.hasPendingUnlink()).toBe(true)
    await reopened.finishUnlink()
    expect(reopened.hasPendingUnlink()).toBe(false)
    expect(m.fetch.mock.calls.filter(([url]) => String(url).endsWith('/logout?scope=global'))).toHaveLength(1)
    expect(m.logout).toHaveBeenCalledTimes(2)
  })
  it.each(['dispose', 'switch'] as const)('revokes the original bearer after an unlink response arrives following %s', async change => {
    m.user = user('alice', true); m.session = session(m.user)
    const originalToken = m.session.access_token
    const originalFetch = m.fetch.getMockImplementation()!
    const flow = (await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')).createAccountLinking('alice')
    m.fetch.mockImplementation(async (raw: string, init: RequestInit) => {
      const response = await originalFetch(raw, init)
      if (raw.includes('/user/identities/') && init.method === 'DELETE') {
        if (change === 'dispose') flow.dispose()
        else m.session = session(user('bob'))
      }
      return response
    })
    await flow.verifyGoogle()
    await flow.unlinkGoogle()
    const revoke = m.fetch.mock.calls.find(([raw]) => String(raw).endsWith('/logout?scope=global'))!
    expect(revoke[1].headers).toMatchObject({ Authorization: `Bearer ${originalToken}` })
    expect(m.logout).toHaveBeenCalledTimes(change === 'dispose' ? 1 : 0)
    if (change === 'switch') expect(m.session.user.id).toBe('bob')
    expect(flow.hasPendingUnlink()).toBe(false)
  })
  it('restores a failed global revocation after reopening settings without persisting bearer credentials', async () => {
    m.user = user('alice', true); m.session = session(m.user)
    const originalFetch = m.fetch.getMockImplementation()!
    m.fetch.mockImplementation(async (raw: string, init: RequestInit) => raw.endsWith('/logout?scope=global')
      ? Response.json({ message: 'Unavailable' }, { status: 503 }) : originalFetch(raw, init))
    const flow = (await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')).createAccountLinking('alice')
    await flow.verifyGoogle()
    await expect(flow.unlinkGoogle()).rejects.toMatchObject({ code: 'signOutFailed' })
    expect(m.logout).not.toHaveBeenCalled()
    const saved = window.localStorage.getItem('gugu-account-unlink-recovery:alice')!
    expect(saved).toBe('"revoke"')
    expect(saved).not.toContain(m.session.access_token)
    flow.dispose()
    vi.resetModules()
    m.fetch.mockImplementation(originalFetch)
    const reopened = (await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')).createAccountLinking('alice')
    expect(reopened.hasPendingUnlink()).toBe(true)
    await reopened.finishUnlink()
    expect(m.logout).toHaveBeenCalledOnce()
    expect(reopened.hasPendingUnlink()).toBe(false)
  })
  it('accepts the first secure-email acknowledgement without adopting its message body as a user', async () => {
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyEmail('123456')
    m.fetch.mockResolvedValueOnce(Response.json({ msg: 'Email change accepted. Confirm the other email.', code: '200' }))
    await expect(flow.confirmEmail('new@example.test', '111111')).resolves.toMatchObject({ complete: false })
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('rejects a different account returned by email confirmation and revokes its temporary session', async () => {
    const original = m.session
    const { createAccountLinking } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const flow = createAccountLinking('alice')
    await flow.verifyEmail('123456')
    m.returned = user('bob')
    await expect(flow.confirmEmail('bob@example.test', '111111')).rejects.toMatchObject({ code: 'ownerChanged' })
    expect(m.accept).not.toHaveBeenCalled()
    expect(m.session).toBe(original)
  })
  it('revokes an unused Google session issued while cancellation was waiting for exchange', async () => {
    m.user = user('alice', true); m.session = session(m.user); m.deferCallback = true
    let finishExchange!: () => void
    const exchange = new Promise<void>(resolve => { finishExchange = resolve })
    const originalFetch = m.fetch.getMockImplementation()!
    m.fetch.mockImplementation(async (raw: string, init: RequestInit) => {
      if (raw.includes('/token?grant_type=pkce')) await exchange
      return originalFetch(raw, init)
    })
    const { createAccountLinking, cancelAccountGoogle } = await import('../../../../apps/desktop/src/lib/accountLinkingAdapter')
    const pending = createAccountLinking('alice').verifyGoogle()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'googleCancelled' })
    await vi.waitFor(() => expect(m.open).toHaveBeenCalledOnce())
    const callbackUrl = new URL(m.open.mock.calls[0]![0]).searchParams.get('redirect_to')!
    const attempt = new URL(callbackUrl).searchParams.get(OAUTH_ATTEMPT_PARAM)
    m.callback!(`gugu-dev://auth/callback?${OAUTH_ATTEMPT_PARAM}=${attempt}&code=returned-code`)
    await vi.waitFor(() => expect(m.fetch.mock.calls.some(([url]) => String(url).includes('/token?grant_type=pkce'))).toBe(true))
    await cancelAccountGoogle()
    finishExchange()
    await rejected
    expect(m.fetch.mock.calls.some(([url]) => String(url).endsWith('/logout?scope=local'))).toBe(true)
    expect(m.accept).not.toHaveBeenCalled()
  })
})
