import type { Session, User } from '@supabase/supabase-js'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { platform } from '../platform'
import { googleAuthorizationUrl, googleIdentityLinkUrl } from '../../shared/google-authorization-url'
import { MAIN_PKCE_STORAGE_KEY, OAUTH_PENDING_STORAGE_KEY } from '../../shared/auth-storage-keys'
import { parseOAuthCallback } from '../../shared/oauth-callback'
import { authCallbacks } from './authCallbacks'
import { authBoundedFetch } from './authBoundedFetch'
import { AccountLinking, AccountLinkingError, LOGIN_METHOD_NOTICE_KEY, type LoginMethodChange, type LoginMethodNotice } from './accountLinking'
import { GoogleLoginFlow } from './googleLoginFlow'
import { sessionCoordinator } from './sessionCoordinator'
import { supabase } from './supabase'
import { logoutAndRelaunch } from './authLogout'
import { accountUnlinkRecovery } from './accountUnlinkRecovery'

// One isolated SDK client per renderer. Its in-memory session and PKCE verifier never reach
// sb-main, native session storage, or SessionCoordinator without checking the original owner.
const storageKey = `sb-account-linking-${crypto.randomUUID()}`
const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}
let isolated: ReturnType<typeof createGuguSupabaseClient> | null = null
function accountAuth() {
  return (isolated ??= createGuguSupabaseClient({ storage, storageKey, persistSession: true, autoRefreshToken: false, flowType: 'pkce', fetch: authBoundedFetch })).auth
}
let active = false
let cancelGoogle: (() => Promise<void>) | null = null
const unlinkCleanupFlights = new Map<string, Promise<void>>()
async function exclusively<T>(work: () => Promise<T>): Promise<T> {
  if (active) throw new Error('An account verification is already in progress')
  active = true
  try { return await work() } finally { values.clear(); active = false }
}
const owner = () => sessionCoordinator.getSnapshot().session?.user.id ?? null
function sameOwner(userId: string, user?: User): void {
  if (owner() !== userId || (user && user.id !== userId)) throw new AccountLinkingError('ownerChanged')
}
async function seed(userId: string): Promise<Session> {
  sameOwner(userId)
  let session = sessionCoordinator.getSnapshot().session!
  if (!session.expires_at || session.expires_at * 1000 - Date.now() < 120_000) {
    await sessionCoordinator.refresh()
    sameOwner(userId)
    session = sessionCoordinator.getSnapshot().session!
    if (!session.expires_at || session.expires_at * 1000 - Date.now() < 120_000) throw new AccountLinkingError('verifyRequired')
  }
  // Initialize before inserting the seed, so the SDK's first restore cannot race this write.
  await accountAuth().initialize()
  values.set(storageKey, JSON.stringify(session))
  return session
}
async function revokeTemporary(session: Session): Promise<void> {
  const { error } = await accountAuth().admin.signOut(session.access_token, 'local')
  if (error) throw error
}
function accountError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code
  if (code && ['email_exists', 'user_already_exists', 'identity_already_exists'].includes(code)) return new AccountLinkingError('occupied')
  if (code === 'manual_linking_disabled') return new AccountLinkingError('linkingUnavailable')
  return error
}
function sessionId(session: Session): string | null {
  try {
    const claims = JSON.parse(atob(session.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: unknown }
    return typeof claims.session_id === 'string' ? claims.session_id : null
  } catch { return null }
}

async function googleAccountFlow(userId: string, link: boolean): Promise<User> {
  return exclusively(async () => {
    const browser = platform.accountOAuthBrowser ?? platform.oauthBrowser
    if (!browser || (link && !browser.openLinkBrowser)) throw new Error('Native identity linking is unavailable')
    values.clear()
    const original = link ? await seed(userId) : null
    await authCallbacks.ready()
    const redirectTo = await authCallbacks.redirectTo()
    let returned: Session | null = null, issued: Session | null = null, failure: unknown = null
    const flow = new GoogleLoginFlow({
      storage: {
        getItem: async key => storage.getItem(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key),
        setItem: async (key, value) => storage.setItem(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key, value),
        removeItem: async key => storage.removeItem(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key),
      },
      redirectTo,
      signIn: async callbackUrl => {
        const result = link
          ? await accountAuth().linkIdentity({ provider: 'google', options: { redirectTo: callbackUrl, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } })
          : await accountAuth().signInWithOAuth({ provider: 'google', options: { redirectTo: callbackUrl, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } })
        if (result.error) failure = accountError(result.error)
        return result
      },
      exchange: async code => {
        const result = await accountAuth().exchangeCodeForSession(code)
        issued = result.data.session
        return result
      },
      openBrowser: async (url, callbackUrl) => link
        ? browser.openLinkBrowser!(googleIdentityLinkUrl(url, getSupabaseUrl()), callbackUrl)
        : browser.openBrowser(googleAuthorizationUrl(url, getSupabaseUrl(), callbackUrl)),
      begin: () => 1,
      accept: async (_attempt, session) => {
        returned = session
        try { sameOwner(userId, session.user) } catch (error) { failure = error; throw error }
      },
    })
    const result = new Promise<User>((resolve, reject) => {
      flow.subscribe(() => {
        const state = flow.getSnapshot()
        if (state.phase === 'succeeded' && returned) resolve(returned.user)
        if (state.phase === 'failed' && !state.busy) reject(failure ?? new AccountLinkingError(state.failure === 'cancelled' ? 'googleCancelled' : 'googleFailed'))
      })
    })
    // Observe early rejection while native listener registration is still pending.
    void result.catch(() => {})
    const stopCallbacks = authCallbacks.subscribeAccount(url => {
      const parsed = parseOAuthCallback(url, redirectTo)
      if (parsed.kind === 'error') {
        const mapped = accountError({ code: parsed.code })
        if (mapped instanceof AccountLinkingError) failure = mapped
      }
      void flow.callback(url)
    }, flow.callbackUnavailable)
    const cancel = flow.cancel
    cancelGoogle = cancel
    let stopBrowser: (() => void) | undefined
    try {
      stopBrowser = await browser.subscribeBrowserFinished?.(flow.browserFinished, flow.callbackUnavailable)
      await flow.start()
      return await result
    } finally {
      stopCallbacks(); stopBrowser?.()
      await flow.cancel()
      if (cancelGoogle === cancel) cancelGoogle = null
      const temporary = issued as Session | null
      if (temporary && (!link || temporary.user.id !== userId
        || (original && sessionId(original) && sessionId(temporary) && sessionId(original) !== sessionId(temporary))))
        await revokeTemporary(temporary)
      values.delete(OAUTH_PENDING_STORAGE_KEY)
    }
  })
}

export const localLoginNoticeKey = (userId: string) => `gugu-login-method-notice:${userId}`
export const cancelAccountGoogle = async () => { await cancelGoogle?.() }
export const accountGoogleAvailable = () => Boolean(platform.authCallbacks && (platform.accountOAuthBrowser ?? platform.oauthBrowser)?.openLinkBrowser)

export function createAccountLinking(userId: string): AccountLinking {
  let unlinkSession: Session | null = null
  return new AccountLinking(userId, {
    currentUserId: owner,
    getUser: async () => {
      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      return data.user
    },
    requestEmailOtp: email => exclusively(async () => {
      const { error } = await accountAuth().signInWithOtp({ email, options: { shouldCreateUser: false } })
      if (error) throw error
    }),
    verifyEmailOtp: (email, token) => exclusively(async () => {
      const { data, error } = await accountAuth().verifyOtp({ email, token, type: 'email' })
      if (error) throw error
      if (!data.session) throw new AccountLinkingError('verifyRequired')
      // Revoke only this newly issued verification session, including a wrong-account result.
      try { sameOwner(userId, data.session.user); return data.session.user }
      finally { await revokeTemporary(data.session) }
    }),
    reverifyGoogle: () => googleAccountFlow(userId, false),
    linkGoogle: () => googleAccountFlow(userId, true),
    changeEmail: email => exclusively(async () => {
      await seed(userId)
      const { data, error } = await accountAuth().updateUser({ email })
      if (error) throw accountError(error)
      sameOwner(userId, data.user)
      return data.user
    }),
    confirmEmail: (email, token) => exclusively(async () => {
      const { data, error } = await accountAuth().verifyOtp({ email, token, type: 'email_change' })
      if (error) throw error
      // auth-js types the first secure-email confirmation's { msg, code } body as a User.
      // It is an acknowledgement, never a session or proof that the email changed.
      const acknowledgement = data.user as unknown as { msg?: unknown; code?: unknown } | null
      if (!data.session && typeof acknowledgement?.msg === 'string' && acknowledgement.code === '200') return null
      if (!data.user?.id) throw new AccountLinkingError('verifyRequired')
      try { sameOwner(userId, data.user) }
      catch (reason) { if (data.session) await revokeTemporary(data.session); throw reason }
      if (data.session) await sessionCoordinator.acceptInteractiveSession(sessionCoordinator.beginInteractiveLogin(), data.session)
      return data.user
    }),
    unlinkGoogle: identity => exclusively(async () => {
      unlinkSession = await seed(userId)
      const { error } = await accountAuth().unlinkIdentity(identity)
      if (error) throw error
      accountUnlinkRecovery.write(userId, 'revoke')
    }),
    pendingUnlink: () => accountUnlinkRecovery.read(userId) !== null,
    recordChange: (kind: LoginMethodChange) => exclusively(async () => {
      if (kind === 'google-unlinked' && unlinkSession) values.set(storageKey, JSON.stringify(unlinkSession))
      else await seed(userId)
      const notice: LoginMethodNotice = { id: crypto.randomUUID(), kind, at: new Date().toISOString() }
      window.localStorage.setItem(localLoginNoticeKey(userId), JSON.stringify(notice))
      const { error } = await accountAuth().updateUser({ data: { [LOGIN_METHOD_NOTICE_KEY]: notice } })
      return !error
    }),
    signOutAll: () => {
      const existing = unlinkCleanupFlights.get(userId)
      if (existing) return existing
      // Revocation uses the original request's credentials and does not take the shared
      // verification lock. A new account's verification must not cancel this cleanup.
      const work = (async () => {
        if (accountUnlinkRecovery.read(userId) === 'revoke') {
          let session = unlinkSession
          if (!session || (session.expires_at ?? 0) * 1000 <= Date.now()) {
            sameOwner(userId)
            session = sessionCoordinator.getSnapshot().session!
            if ((session.expires_at ?? 0) * 1000 <= Date.now()) {
              await sessionCoordinator.refresh()
              sameOwner(userId)
              session = sessionCoordinator.getSnapshot().session!
            }
          }
          const { error } = await accountAuth().admin.signOut(session.access_token, 'global')
          if (error) throw new AccountLinkingError('signOutFailed')
          accountUnlinkRecovery.write(userId, 'local')
        }
        // Selecting another account already removed this account locally. Do not sign
        // out the newly selected account when the old revocation response arrives.
        if (owner() !== userId) { accountUnlinkRecovery.clear(userId); return }
        const result = await logoutAndRelaunch(() => accountUnlinkRecovery.clear(userId))
        if (!result.success) throw new AccountLinkingError('signOutFailed')
      })()
      const flight = work.finally(() => { unlinkCleanupFlights.delete(userId) })
      unlinkCleanupFlights.set(userId, flight)
      return flight
    },
  })
}
