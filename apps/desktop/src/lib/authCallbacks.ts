import { platform } from '../platform'
import { OpenedLinkInbox } from '../../shared/opened-link-inbox'

const inbox = new OpenedLinkInbox()
const errors = new Set<(error: unknown) => void>()
const accountListeners = new Set<(url: string) => void>()
let failure: { error: unknown } | null = null
let authenticated = false

/** Callbacks are retained until an interactive auth flow subscribes. Neither the authenticated
 * shell nor extension navigation ever sees the authorization code. */
export const authCallbacks = {
  setAuthenticated(value: boolean): void {
    authenticated = value
    if (value) inbox.clear('auth')
  },
  async redirectTo(): Promise<string> {
    if (!platform.authCallbacks) throw new Error('Native authentication callbacks are unavailable')
    return platform.authCallbacks.redirectTo()
  },
  async ready(): Promise<void> {
    if (!platform.authCallbacks) throw new Error('Native authentication callbacks are unavailable')
    await platform.authCallbacks.ready()
    failure = null
  },
  subscribe(listener: (url: string) => void, onError: (error: unknown) => void): () => void {
    errors.add(onError)
    const unsubscribe = inbox.subscribe('auth', listener)
    if (failure) onError(failure.error)
    return () => { unsubscribe(); errors.delete(onError) }
  },
  subscribeAccount(listener: (url: string) => void, onError: (error: unknown) => void): () => void {
    accountListeners.add(listener)
    errors.add(onError)
    if (failure) onError(failure.error)
    return () => { accountListeners.delete(listener); errors.delete(onError) }
  },
}

/** App owns the sole upstream subscription and starts it before deciding which login view to show. */
export function startAuthCallbackRouting(): () => void {
  if (!platform.authCallbacks) return () => {}
  failure = null
  return platform.authCallbacks.subscribe((url) => {
    if (!authenticated) inbox.push(url)
    else for (const listener of accountListeners) listener(url)
  }, (error) => {
    failure = { error }
    for (const report of errors) report(error)
  })
}
