import { withBoundedOperation } from './boundedOperation'

export interface RuntimeAuth {
  accessToken: string
  refreshToken?: string | null
  userId: string
}

export interface RuntimeAuthProvider {
  getAuth: (options?: { forceRefresh?: boolean }) => Promise<RuntimeAuth | null>
}

export class RuntimeAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeAuthError'
  }
}

// @@@auth-loss-permanent - PERMANENT auth loss: GoTrue rejected the refresh token outright (400
export class RuntimeAuthExpiredError extends RuntimeAuthError {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeAuthExpiredError'
  }
}

export const RUNTIME_AUTH_REFRESH_TIMEOUT_MS = 30_000

/** 登录服务这一下没答上来(连不上、5xx、超时、退避中):票没被拒,登录还在 —— 界面说「咕咕这边出错了」,❌ 说登录失效(#7103)。 */
export class RuntimeAuthUnavailableError extends RuntimeAuthError {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeAuthUnavailableError'
  }
}

export class RuntimeAuthRefreshTimeoutError extends RuntimeAuthUnavailableError {
  constructor(readonly timeoutMs: number) {
    super(`Supabase token refresh timed out after ${timeoutMs}ms`)
    this.name = 'RuntimeAuthRefreshTimeoutError'
  }
}

/**
 * A JWT's claims, in Node and in a browser alike (atob, not Buffer): the phone's outer page reads tokens with these too,
 * and Buffer there quietly answered null (measured, WebView 113). Not a token ⇒ null; the signature is never read.
 */
function tokenClaims(token: string): { sub?: unknown; exp?: unknown } | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown; exp?: unknown }
  } catch {
    return null
  }
}

export function userIdFromSupabaseAccessToken(accessToken: string): string | null {
  const sub = tokenClaims(accessToken)?.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : null
}

export function runtimeAuthFromSupabaseTokens(input: {
  accessToken: string
  refreshToken?: string | null
}): RuntimeAuth {
  const userId = userIdFromSupabaseAccessToken(input.accessToken)
  if (!userId) throw new RuntimeAuthError('Authenticated Supabase access token is missing sub')
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    userId
  }
}

export function accessTokenExpirySeconds(accessToken: string): number | null {
  const exp = tokenClaims(accessToken)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
}

// @@@refresh-rotates-chain - one GoTrue refresh-token use rotates the whole chain server-side, so the
export async function refreshSupabaseSession(input: {
  supabaseUrl: string
  anonKey: string
  refreshToken: string
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}): Promise<{ accessToken: string; refreshToken: string }> {
  const url = `${input.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`
  const doFetch = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? RUNTIME_AUTH_REFRESH_TIMEOUT_MS
  return await withBoundedOperation(
    timeoutMs,
    () => new RuntimeAuthRefreshTimeoutError(timeoutMs),
    async (signal) => {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { apikey: input.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: input.refreshToken }),
        signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // @@@classify-refresh-failure - a 400 from GoTrue means the refresh token itself was rejected
        if (response.status === 400) {
          throw new RuntimeAuthExpiredError(`Supabase token refresh rejected (400): ${body}`)
        }
        throw new RuntimeAuthUnavailableError(`Supabase token refresh failed (${response.status}): ${body}`)
      }
      const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown }
      if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
        throw new RuntimeAuthUnavailableError('Supabase token refresh response is missing access/refresh tokens')
      }
      return { accessToken: data.access_token, refreshToken: data.refresh_token }
    }
  )
}

export interface RefreshingRuntimeAuthProviderInput {
  supabaseUrl: string
  anonKey: string
  accessToken: string
  refreshToken: string
  /** Pin this provider to one owner across the initial token and every refresh rotation. */
  expectedUserId?: string
  onTokens?: (tokens: { accessToken: string; refreshToken: string }) => void | Promise<void>
  /**
   * #6264 Runs right before each refresh. Throwing skips the refresh (treated as TRANSIENT: bounded backoff,
   * the cached access token keeps being served while it is still valid). A host that must persist the rotated
   * refresh token uses it to reserve room on disk first — GoTrue refresh tokens are single-use, so rotating
   * without being able to save the result turns the next restart into a permanent sign-out.
   */
  beforeRefresh?: () => void | Promise<void>
  // @@@auth-expired-hook - fired exactly once when refresh hits PERMANENT loss, so the wiring (desktop
  // main, CLI host) can surface a single loud signal / native notification without polling.
  onAuthExpired?: (error: RuntimeAuthExpiredError) => void
  now?: () => number
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  refreshTimeoutMs?: number
  skewSeconds?: number
  // Bounded exponential backoff bounds for TRANSIENT refresh failures (so we don't hammer GoTrue).
  backoffBaseMs?: number
  backoffMaxMs?: number
}

// @@@headless-host-refresh - A headless `gugu runtime host start` has no renderer to keep its GoTrue
export function createRefreshingRuntimeAuthProvider(
  input: RefreshingRuntimeAuthProviderInput
): RuntimeAuthProvider {
  let accessToken = input.accessToken
  let refreshToken = input.refreshToken
  const skew = input.skewSeconds ?? 60
  const now = input.now ?? (() => Date.now() / 1000)
  const doFetch = input.fetchImpl ?? fetch
  const backoffBaseMs = input.backoffBaseMs ?? 5_000
  const backoffMaxMs = input.backoffMaxMs ?? 5 * 60_000
  let inflight: Promise<void> | null = null
  // @@@refresh-spin-guards - two terminal/holdoff states keep getAuth() from hammering GoTrue:
  let expired: RuntimeAuthExpiredError | null = null
  let backoffUntilMs = 0
  let backoffStep = 0

  function expire(error: RuntimeAuthExpiredError): RuntimeAuthExpiredError {
    if (!expired) {
      expired = error
      input.onAuthExpired?.(error)
    }
    return expired
  }

  function assertExpectedUser(access: string, source: string): void {
    if (!input.expectedUserId) return
    const actualUserId = userIdFromSupabaseAccessToken(access)
    if (actualUserId !== input.expectedUserId) {
      throw new RuntimeAuthExpiredError(
        `Supabase ${source} access token owner mismatch: expected ${input.expectedUserId}, got ${actualUserId ?? 'missing sub'}`
      )
    }
  }

  async function refresh(): Promise<void> {
    try {
      if (input.beforeRefresh) await input.beforeRefresh()
      const rotated = await refreshSupabaseSession({
        supabaseUrl: input.supabaseUrl,
        anonKey: input.anonKey,
        refreshToken,
        fetchImpl: doFetch,
        timeoutMs: input.refreshTimeoutMs,
      })
      assertExpectedUser(rotated.accessToken, 'refreshed')
      accessToken = rotated.accessToken
      refreshToken = rotated.refreshToken
      backoffStep = 0
      backoffUntilMs = 0
      if (input.onTokens) await input.onTokens({ accessToken, refreshToken })
    } catch (err) {
      if (err instanceof RuntimeAuthExpiredError) {
        throw expire(err)
      }
      // TRANSIENT: arm bounded exponential backoff before the next attempt, then re-throw so the
      // caller sees the failure this tick (it does not silently succeed).
      const delayMs = Math.min(backoffBaseMs * 2 ** backoffStep, backoffMaxMs)
      backoffStep += 1
      backoffUntilMs = now() * 1000 + delayMs
      throw err
    }
  }

  async function ensureFresh(forceRefresh = false): Promise<void> {
    if (expired) throw expired
    try {
      assertExpectedUser(accessToken, 'initial')
    } catch (err) {
      if (err instanceof RuntimeAuthExpiredError) throw expire(err)
      throw err
    }
    const exp = accessTokenExpirySeconds(accessToken)
    if (!forceRefresh && exp !== null && exp - skew > now()) return
    // Inside the transient backoff window: don't re-hit GoTrue. If the cached token is still usable,
    // serve it; otherwise fail loud (the host will surface lastError) until the holdoff elapses.
    if (now() * 1000 < backoffUntilMs) {
      if (!forceRefresh && exp !== null && exp > now()) return
      throw new RuntimeAuthUnavailableError('Supabase token refresh is backing off after a transient failure')
    }
    // Single-flight: concurrent ticks share one refresh so the rotating chain isn't double-spent.
    if (!inflight) inflight = refresh().finally(() => { inflight = null })
    await inflight
  }

  return {
    async getAuth(options) {
      if (!accessToken || !refreshToken) return null
      await ensureFresh(options?.forceRefresh)
      return runtimeAuthFromSupabaseTokens({ accessToken, refreshToken })
    }
  }
}

export async function requireRuntimeAuth(
  provider: RuntimeAuthProvider,
  owner: string
): Promise<RuntimeAuth> {
  const auth = await provider.getAuth()
  if (!auth?.accessToken || !auth.userId) {
    throw new RuntimeAuthError(`${owner} requires authenticated Supabase runtime auth`)
  }
  return auth
}
