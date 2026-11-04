import type { Session } from '@supabase/supabase-js'
import { parseOAuthCallback } from '../../shared/oauth-callback'
import { MAIN_PKCE_STORAGE_KEY, OAUTH_PENDING_STORAGE_KEY } from '../../shared/auth-storage-keys'
import { isOAuthAttemptId, oauthAttemptRedirect, readOAuthAttempt } from '../../shared/oauth-attempt'

export const GOOGLE_LOGIN_TIMEOUT_MS = 5 * 60_000
export type GoogleLoginFailure = 'cancelled' | 'timeout' | 'invalidCallback' | 'invalidCode' | 'provider' | 'browser' | 'exchange' | 'storage' | 'callbackUnavailable'
export type GoogleLoginState = {
  phase: 'idle' | 'restoring' | 'authorizing' | 'exchanging' | 'accepting' | 'succeeded' | 'failed'
  failure?: GoogleLoginFailure
  notice?: 'staleCallback'
  busy: boolean
}
export interface GoogleLoginDeps {
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
  redirectTo: string
  signIn: (redirectTo: string) => Promise<{ data: { url: string | null }; error: unknown }>
  exchange: (code: string) => Promise<{ data: { session: Session | null }; error: unknown }>
  openBrowser: (url: string, redirectTo: string) => Promise<void>
  begin: () => number
  accept: (attempt: number, session: Session) => Promise<void>
  now?: () => number
  newAttemptId?: () => string
}
export async function clearOAuthTemporaryStorage(storage: Pick<GoogleLoginDeps['storage'], 'removeItem'>): Promise<void> {
  const results = await Promise.allSettled([storage.removeItem(OAUTH_PENDING_STORAGE_KEY), storage.removeItem(MAIN_PKCE_STORAGE_KEY)])
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
const invalidCode = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code
  return code !== undefined && ['bad_code_verifier', 'flow_state_expired', 'flow_state_not_found', 'validation_failed',
    'invalid_grant', 'pkce_code_verifier_not_found'].includes(code)
}

/** PKCE verifies the code/verifier pair on GoTrue. Only the current explicit interactive attempt
 * can publish its returned session; cancellation never turns a late exchange into a new login. */
export class GoogleLoginFlow {
  private state: GoogleLoginState = { phase: 'idle', busy: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiresAt: number | null = null
  private attempt: number | null = null
  private attemptId: string | null = null
  private generation = 0
  private operations = 0
  private cleanups = 0
  constructor(private readonly deps: GoogleLoginDeps) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): GoogleLoginState => this.state
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private current(generation: number): boolean { return generation === this.generation }
  private publish(state: GoogleLoginState): void { this.state = state; for (const listener of this.listeners) listener() }
  private refreshBusy(): void {
    if (this.state.phase === 'failed') this.publish({ ...this.state, busy: this.operations > 0 || this.cleanups > 0 })
  }
  private arm(): void {
    clearTimeout(this.timer)
    const remaining = this.expiresAt! - this.now()
    this.timer = setTimeout(() => { void this.end('timeout') }, Math.max(0, remaining))
  }
  private async clearKeys(): Promise<void> {
    this.cleanups++
    try {
      await clearOAuthTemporaryStorage(this.deps.storage)
    } finally { this.cleanups--; this.refreshBusy() }
  }
  private async end(failure: GoogleLoginFailure): Promise<void> {
    ++this.generation
    clearTimeout(this.timer)
    this.expiresAt = null
    this.attempt = null
    this.attemptId = null
    this.publish({ phase: 'failed', failure, busy: true })
    try { await this.clearKeys() }
    catch { this.publish({ phase: 'failed', failure: 'storage', busy: this.operations > 0 || this.cleanups > 0 }) }
  }
  private async operationDone(generation: number): Promise<void> {
    // A cancelled SDK operation can write its verifier after the first cleanup. Do not enable
    // another attempt until it has actually ended and that late verifier has also been removed.
    if (!this.current(generation) && this.state.phase !== 'succeeded') {
      try { await this.clearKeys() }
      catch { this.publish({ phase: 'failed', failure: 'storage', busy: true }) }
    }
    this.operations--
    this.refreshBusy()
  }
  async restore(): Promise<void> {
    if (this.operations || this.expiresAt !== null) return
    const generation = ++this.generation
    this.operations++
    this.publish({ phase: 'restoring', busy: true })
    try {
      const raw = await this.deps.storage.getItem(OAUTH_PENDING_STORAGE_KEY)
      if (!this.current(generation)) return
      if (raw === null) { this.publish({ phase: 'idle', busy: false }); return }
      const pending = JSON.parse(raw) as { version?: unknown; id?: unknown; phase?: unknown; expiresAt?: unknown }
      if (pending.version !== 1 || !isOAuthAttemptId(pending.id) || !['authorizing', 'exchanging'].includes(String(pending.phase))
        || typeof pending.expiresAt !== 'number' || !Number.isFinite(pending.expiresAt)) {
        await this.end('storage'); return
      }
      if (pending.phase === 'exchanging') { await this.end('invalidCode'); return }
      this.attemptId = pending.id
      this.expiresAt = pending.expiresAt
      if (this.now() >= this.expiresAt) { await this.end('timeout'); return }
      this.arm()
      const verifier = await this.deps.storage.getItem(MAIN_PKCE_STORAGE_KEY)
      if (!this.current(generation)) return
      if (!verifier) { await this.end('invalidCode'); return }
      this.attempt = this.deps.begin()
      this.publish({ phase: 'authorizing', busy: true })
    } catch { if (this.current(generation)) await this.end('storage') }
    finally { await this.operationDone(generation) }
  }
  async start(): Promise<void> {
    if (this.operations || this.cleanups || this.expiresAt !== null) return
    const generation = ++this.generation
    this.operations++
    this.attempt = this.deps.begin()
    this.expiresAt = this.now() + GOOGLE_LOGIN_TIMEOUT_MS
    this.arm()
    this.publish({ phase: 'authorizing', busy: true })
    let failure: GoogleLoginFailure = 'storage'
    try {
      this.attemptId = this.deps.newAttemptId?.() ?? crypto.randomUUID()
      const redirectTo = oauthAttemptRedirect(this.deps.redirectTo, this.attemptId)
      await this.clearKeys()
      if (!this.current(generation)) return
      await this.deps.storage.setItem(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: this.attemptId, phase: 'authorizing', expiresAt: this.expiresAt }))
      if (!this.current(generation)) return
      failure = 'provider'
      const result = await this.deps.signIn(redirectTo)
      if (!this.current(generation)) return
      if (result.error || !result.data.url) { await this.end('provider'); return }
      failure = 'storage'
      const verifier = await this.deps.storage.getItem(MAIN_PKCE_STORAGE_KEY)
      if (!this.current(generation)) return
      if (!verifier) { await this.end('storage'); return }
      failure = 'browser'
      await this.deps.openBrowser(result.data.url, redirectTo)
    } catch { if (this.current(generation)) await this.end(failure) }
    finally { await this.operationDone(generation) }
  }
  cancel = async (): Promise<void> => {
    if (this.expiresAt !== null && this.state.phase !== 'accepting') await this.end('cancelled')
  }
  browserFinished = (): void => {
    if (this.state.phase === 'authorizing') void this.end(this.expiresAt !== null && this.now() >= this.expiresAt ? 'timeout' : 'cancelled')
  }
  callbackUnavailable = (): void => {
    if (this.state.phase !== 'accepting' && this.state.phase !== 'succeeded') void this.end('callbackUnavailable')
  }
  async callback(raw: string): Promise<void> {
    if (this.state.phase === 'exchanging' || this.state.phase === 'accepting' || this.state.phase === 'succeeded') return
    if (this.expiresAt === null) return // Unsolicited / already-terminal callbacks never enter a later attempt.
    if (readOAuthAttempt(raw, this.deps.redirectTo) !== this.attemptId) {
      this.publish({ ...this.state, notice: 'staleCallback' })
      return
    }
    const callback = parseOAuthCallback(raw, this.deps.redirectTo)
    if (callback.kind === 'invalid') { await this.end('invalidCallback'); return }
    if (this.now() >= this.expiresAt) { await this.end('timeout'); return }
    if (callback.kind === 'cancelled') { await this.end('cancelled'); return }
    if (callback.kind === 'error') {
      await this.end(['bad_oauth_state', 'flow_state_expired', 'flow_state_not_found'].includes(callback.code) ? 'invalidCode' : 'provider'); return
    }
    // Claim synchronously, before native storage awaits: a same-turn browserFinished cannot cancel
    // a callback which has already arrived, and duplicate OS intents cannot exchange the code twice.
    const generation = this.generation
    const attempt = this.attempt!
    this.operations++
    this.publish({ phase: 'exchanging', busy: true })
    let failure: GoogleLoginFailure = 'storage'
    try {
      const verifier = await this.deps.storage.getItem(MAIN_PKCE_STORAGE_KEY)
      if (!this.current(generation)) return
      if (!verifier) { await this.end('invalidCode'); return }
      // A crashed exchange has an unknown server outcome. Persist the claim before requesting it;
      // a restarted client must ask for a fresh authorization, never submit the same code twice.
      await this.deps.storage.setItem(OAUTH_PENDING_STORAGE_KEY, JSON.stringify({ version: 1, id: this.attemptId, phase: 'exchanging', expiresAt: this.expiresAt }))
      if (!this.current(generation)) return
      failure = 'exchange'
      const { data, error } = await this.deps.exchange(callback.code)
      if (!this.current(generation)) return
      if (error || !data.session) { await this.end(invalidCode(error) || !error ? 'invalidCode' : 'exchange'); return }
      failure = 'storage'
      await this.clearKeys()
      if (!this.current(generation)) return
      clearTimeout(this.timer)
      this.publish({ phase: 'accepting', busy: true })
      failure = 'exchange'
      await this.deps.accept(attempt, data.session)
      if (this.current(generation)) {
        this.expiresAt = null
        this.attempt = null
        this.attemptId = null
        this.publish({ phase: 'succeeded', busy: false })
      }
    } catch { if (this.current(generation)) await this.end(failure) }
    finally { await this.operationDone(generation) }
  }
}
