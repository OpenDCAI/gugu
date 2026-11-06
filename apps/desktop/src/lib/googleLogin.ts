import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { platform } from '../platform'
import { googleAuthorizationUrl } from '../../shared/google-authorization-url'
import { oauthHandoffRedirect } from '../../shared/oauth-attempt'
import { authCallbacks } from './authCallbacks'
import { mainAuthTemporaryStorage, supabase } from './supabase'
import { sessionCoordinator } from './sessionCoordinator'
import { clearPendingReferrer } from './referral'
import { clearOAuthTemporaryStorage, GoogleLoginFlow, type GoogleLoginState } from './googleLoginFlow'

const listeners = new Set<() => void>()
let snapshot: GoogleLoginState = { phase: 'idle', busy: false }
let preparing: Promise<GoogleLoginFlow | null> | null = null
function publish(state: GoogleLoginState): void { snapshot = state; for (const listener of listeners) listener() }
async function waitForAuthDecision(): Promise<void> {
  if (sessionCoordinator.getSnapshot().status !== 'boot-restoring') return
  await new Promise<void>((resolve) => {
    const stop = sessionCoordinator.subscribe(() => {
      if (sessionCoordinator.getSnapshot().status !== 'boot-restoring') { stop(); resolve() }
    })
    if (sessionCoordinator.getSnapshot().status !== 'boot-restoring') { stop(); resolve() }
  })
}

/** One flow and one browser-close subscription per renderer lifetime. App starts it before the
 * login page is selected; remounting that page never duplicates native listeners or loses a code. */
function prepare(): Promise<GoogleLoginFlow | null> {
  if (preparing) return preparing
  const browser = platform.oauthBrowser
  if (!browser) return Promise.reject(new Error('Native OAuth browser is unavailable'))
  preparing = (async () => {
    await waitForAuthDecision()
    const authenticated = Boolean(sessionCoordinator.getSnapshot().session)
    authCallbacks.setAuthenticated(authenticated)
    if (authenticated) {
      await clearOAuthTemporaryStorage(mainAuthTemporaryStorage)
      publish({ phase: 'idle', busy: false })
      preparing = null // A later logout must initialize the anonymous callback/browser subscriptions.
      return null
    }
    await authCallbacks.ready()
    const redirectTo = await authCallbacks.redirectTo()
    const flow = new GoogleLoginFlow({
      storage: mainAuthTemporaryStorage,
      redirectTo,
      signIn: (callbackUrl) => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: oauthHandoffRedirect(callbackUrl), skipBrowserRedirect: true } }),
      exchange: (code) => supabase.auth.exchangeCodeForSession(code),
      openBrowser: (url, callbackUrl) => browser.openBrowser(googleAuthorizationUrl(url, getSupabaseUrl(), oauthHandoffRedirect(callbackUrl))),
      begin: () => sessionCoordinator.beginInteractiveLogin(),
      accept: async (attempt, session) => {
        clearPendingReferrer()
        await sessionCoordinator.acceptInteractiveSession(attempt, session)
      },
    })
    flow.subscribe(() => publish(flow.getSnapshot()))
    let restored = false
    let browserClosed = false
    // Registration rejection prevents authorization. A close seen while native storage restores
    // is applied after the retained callback is dispatched, so an arrived code takes precedence.
    await browser.subscribeBrowserFinished?.(() => {
      if (restored) flow.browserFinished()
      else browserClosed = true
    }, flow.callbackUnavailable)
    await flow.restore()
    authCallbacks.subscribe((url) => { void flow.callback(url) }, flow.callbackUnavailable)
    restored = true
    if (browserClosed) flow.browserFinished()
    return flow
  })().catch((error: unknown) => {
    preparing = null
    publish({ phase: 'failed', failure: 'callbackUnavailable', busy: false })
    throw error
  })
  return preparing
}

export const googleLogin = {
  available: Boolean(platform.authCallbacks && platform.oauthBrowser),
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot: (): GoogleLoginState => snapshot,
  initialize(): void {
    if (this.available) {
      if (!preparing) publish({ phase: 'restoring', busy: true })
      void prepare().then((flow) => { if (flow) publish(flow.getSnapshot()) }).catch(() => { /* prepare publishes the failure. */ })
    }
  },
  async start(): Promise<void> {
    try {
      const flow = await prepare()
      if (flow && !sessionCoordinator.getSnapshot().session) {
        // The native source may have reported a later delivery failure. Re-establish readiness
        // before every authorization, rather than opening a browser with a broken return path.
        try { await authCallbacks.ready() }
        catch { flow.callbackUnavailable(); return }
        await flow.start()
      }
    } catch { /* prepare publishes the failure. */ }
  },
  async cancel(): Promise<void> { try { await (await prepare())?.cancel() } catch { /* prepare publishes the failure. */ } },
}
