import { createClient } from '@supabase/supabase-js'
import { uuid } from './phone-agent-store.mjs'

export function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { throw new Error('owner access token is malformed') }
}
const permanentAuthCodes = new Set(['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found', 'user_banned'])
async function authHttpError(response, operation) {
  const body = await response.json().catch(() => ({}))
  const code = typeof body.error_code === 'string' ? body.error_code : typeof body.code === 'string' ? body.code : 'auth_failed'
  const message = typeof body.msg === 'string' ? body.msg : typeof body.message === 'string' ? body.message : typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `${operation}: HTTP ${response.status}`
  return Object.assign(new Error(message), { code, status: response.status, permanent: (response.status === 400 || response.status === 401) && permanentAuthCodes.has(code) })
}

/** Node is the phone's sole refresh authority; data clients never own a GoTrue session. */
export function createPhoneAgentCloud(config, onSession, fetcher = fetch) {
  const url = new URL(config.supabaseUrl)
  if (url.protocol !== 'https:') throw new Error('Supabase URL must use HTTPS')
  const root = url.href.replace(/\/$/, '')
  const ownerId = uuid(config.ownerId, 'ownerId')
  let current = null
  let refreshing = null
  let stopped = false
  let refreshTimer = null
  let realtime = null
  let paused = false
  let retryDelayMs = 1_000
  let terminalError = null
  const timedFetch = (input, init = {}) => fetcher(input, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })
  const headers = (token) => ({ apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  const arm = () => {
    clearTimeout(refreshTimer)
    if (stopped || paused || !current) return
    const nextRefreshMs = Math.max(1_000, Number(current.expires_at) * 1_000 - Date.now() - 60_000)
    refreshTimer = setTimeout(attemptRefresh, nextRefreshMs)
  }
  const attemptRefresh = () => {
    void refresh().catch(async (error) => {
      if (stopped || paused) return
      await onSession(null, error)
      if (error.permanent) return
      refreshTimer = setTimeout(attemptRefresh, retryDelayMs)
      retryDelayMs = Math.min(60_000, retryDelayMs * 2)
    })
  }
  const adopt = async (session, verified = false) => {
    const claims = jwtClaims(session.access_token)
    if (claims.sub !== ownerId) throw new Error('owner token does not belong to this phone host')
    // A delayed WebView configure must never put a rotated token back.
    if (!verified && current && Number(claims.iat ?? 0) < Number(jwtClaims(current.access_token).iat ?? 0)) return false
    if (!verified && current && claims.iat === jwtClaims(current.access_token).iat && session.access_token !== current.access_token) return false
    let user = session.user
    if (!verified || !user) {
      const response = await timedFetch(`${root}/auth/v1/user`, { headers: headers(session.access_token) })
      if (!response.ok) throw await authHttpError(response, 'owner authentication failed')
      user = await response.json()
      if (user.id !== ownerId) throw new Error('authenticated owner mismatch')
    }
    current = { ...session, user, token_type: session.token_type ?? 'bearer', expires_at: session.expires_at ?? claims.exp, expires_in: Math.max(0, Number(session.expires_at ?? claims.exp) - Math.floor(Date.now() / 1000)) }
    terminalError = null
    await onSession(current)
    if (realtime) await realtime.setAuth(current.access_token)
    retryDelayMs = 1_000
    arm()
    return true
  }
  const refresh = async () => {
    if (refreshing) return refreshing
    if (terminalError) throw terminalError
    if (paused || stopped) throw new Error('phone host authentication is paused')
    if (!current?.refresh_token) throw new Error('phone host has no owner refresh token')
    refreshing = (async () => {
      const response = await timedFetch(`${root}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: headers(config.supabaseAnonKey), body: JSON.stringify({ refresh_token: current.refresh_token }) })
      if (!response.ok) {
        const error = await authHttpError(response, 'owner token refresh failed')
        if (error.permanent) { terminalError = error; clearTimeout(refreshTimer) }
        throw error
      }
      const next = await response.json()
      await adopt(next, true)
      return current
    })().finally(() => { refreshing = null })
    return refreshing
  }
  const token = async () => {
    if (stopped) throw new Error('phone host authentication stopped')
    if (terminalError) throw terminalError
    if (paused) throw new Error('phone host authentication is paused')
    if (!current) throw new Error('phone host owner is not authenticated')
    if (Number(current.expires_at) * 1_000 - Date.now() < 60_000) await refresh()
    return current.access_token
  }
  // supabase-js asks for an initial realtime token in its constructor, before start() verifies
  // the owner. No data request or channel is opened until start() has succeeded.
  const client = createClient(root, config.supabaseAnonKey, { accessToken: async () => current ? token() : null, global: { fetch: timedFetch } })
  realtime = client.realtime
  const identity = client.schema('identity')
  const chat = client.schema('chat')
  const rpc = async (schema, name, args) => {
    const { data, error } = await (schema === 'identity' ? identity : chat).rpc(name, args)
    if (error) throw new Error(`${name}: ${error.message}`)
    return data
  }
  return {
    root, client, identity, chat, rpc, token,
    attachmentEndpoint: async () => ({ supabaseUrl: root, anonKey: config.supabaseAnonKey, token: await token(), fetch: timedFetch }),
    async start() {
      const claims = jwtClaims(config.accessToken)
      if (claims.sub !== ownerId) throw new Error('owner token does not belong to this phone host')
      if (Number(claims.exp) * 1_000 <= Date.now()) {
        current = { access_token: config.accessToken, refresh_token: config.refreshToken, expires_at: claims.exp }
        await refresh()
      } else {
        try { await adopt({ access_token: config.accessToken, refresh_token: config.refreshToken, expires_at: config.expiresAt }) }
        catch (error) {
          if (error.code !== 'bad_jwt') throw error
          current = { access_token: config.accessToken, refresh_token: config.refreshToken, expires_at: claims.exp }
          await refresh()
        }
      }
      return current
    },
    async configure(next) {
      if (next.ownerId !== ownerId || next.supabaseUrl.replace(/\/$/, '') !== root) throw new Error('phone host configure cannot change account or endpoint')
      await refreshing?.catch(() => undefined)
      if (next.accessToken !== current?.access_token) await adopt({ access_token: next.accessToken, refresh_token: next.refreshToken, expires_at: next.expiresAt })
    },
    async session(refreshToken) {
      // A request holding a retired token receives the latest session instead of rotating the retired one.
      if (refreshToken && refreshToken === current?.refresh_token) await refresh()
      else await token()
      return current
    },
    async signOut() {
      clearTimeout(refreshTimer)
      await refreshing?.catch(() => undefined)
      // Refresh, if necessary, before freezing the authority for logout.
      if (!terminalError) await token()
      paused = true; clearTimeout(refreshTimer)
      const session = current
      try {
        const response = await timedFetch(`${root}/auth/v1/logout?scope=local`, { method: 'POST', headers: headers(session.access_token) })
        if (!response.ok && response.status !== 401) throw await authHttpError(response, '退出登录失败')
        return session
      } catch (error) { paused = false; arm(); throw error }
    },
    async modelAccess(body) {
      const response = await timedFetch(`${root}/functions/v1/model-access`, { method: 'POST', headers: headers(await token()), body: JSON.stringify(body) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `model access HTTP ${response.status}`), { code: data.reason ?? 'model_access_failed' })
      return data
    },
    async close() { stopped = true; clearTimeout(refreshTimer); await refreshing?.catch(() => undefined); await client.removeAllChannels(); client.realtime.disconnect() },
  }
}
