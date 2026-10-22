import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Session } from '@supabase/supabase-js'
import { createPhoneHostAuthGate } from './phoneHostAuthGate'
import { getRendererSession } from './sessionPublication'

type SessionResult = { data: { session: Session | null }; error: unknown }
type HostAuthResult = { available: boolean; session: Session | null; signedOut?: boolean }
const native = registerPlugin<{
  authSession(input: { action: 'get' | 'refresh' | 'sign_out'; refreshToken?: string }): Promise<HostAuthResult>
}>('GuguAgent')
const ordered = createPhoneHostAuthGate()
const available = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('GuguAgent')
export const phoneHostAuthAvailable = available
let returnedSession: { sourceRefreshToken: string; session: Session } | null = null
let captureAuthBarrier: () => Promise<unknown> = () => Promise.resolve()
export function setPhoneHostAuthHandoffBarrier(capture: () => Promise<unknown>): void { captureAuthBarrier = capture }

/** A coordinator budget can expire before its SDK request settles and rotates the credential.
 * The ordered gate still awaits that real request. Keep its successful response for this exact
 * source session, so transferring ownership never reuses the retired token. */
async function rememberSessionResult(work: () => Promise<SessionResult>): Promise<SessionResult> {
  const source = getRendererSession()
  const result = await work()
  const next = result.data.session
  if (!result.error && source && next && next.user.id === source.user.id) {
    returnedSession = { sourceRefreshToken: source.refresh_token, session: next }
  }
  return result
}

export function phoneHostSessionForHandoff(current: Session): Session {
  const returned = returnedSession
  return returned && returned.session.user.id === current.user.id && returned.sourceRefreshToken === current.refresh_token
    ? returned.session : current
}

/** Configure must wait for any renderer refresh already in flight; afterwards Node owns refresh. */
export function withPhoneHostAuthHandoff<T>(work: () => Promise<T>): Promise<T> {
  if (!available()) return work()
  // Capture before queueing: later auth calls are queued behind this transfer and must delegate
  // to Node. Earlier calls must finish persistence/publication, not merely their SDK request.
  const admitted = captureAuthBarrier()
  return ordered(async () => { await admitted; return work() })
}

export function phoneHostGetSession(fallback: () => Promise<SessionResult>): Promise<SessionResult> {
  if (!available()) return fallback()
  return ordered(() => rememberSessionResult(async () => {
    const host = await native.authSession({ action: 'get' })
    return host.available ? { data: { session: host.session }, error: null } : fallback()
  }))
}

export function phoneHostRefreshSession(refreshToken: string, fallback: () => Promise<SessionResult>): Promise<SessionResult> {
  if (!available()) return fallback()
  return ordered(() => rememberSessionResult(async () => {
    const host = await native.authSession({ action: 'refresh', refreshToken })
    return host.available ? { data: { session: host.session }, error: null } : fallback()
  }))
}

export function phoneHostRestoreSession(fallback: () => Promise<SessionResult>): Promise<SessionResult> {
  return phoneHostGetSession(fallback)
}

export function phoneHostSignOut(fallback: () => Promise<{ error: unknown }>): Promise<{ error: unknown; signedOutSession?: Session }> {
  if (!available()) return fallback()
  return ordered(async () => {
    const host = await native.authSession({ action: 'sign_out' })
    if (!host.available) {
      const result = await fallback()
      if (!result.error) returnedSession = null
      return result
    }
    if (!host.signedOut || !host.session) throw new Error('手机宿主没有确认退出登录')
    returnedSession = null
    return { error: null, signedOutSession: host.session }
  })
}
