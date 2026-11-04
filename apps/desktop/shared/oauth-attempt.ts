export const OAUTH_ATTEMPT_PARAM = 'gugu_oauth_attempt'
export const OAUTH_HANDOFF_URL = 'https://gugu.nextmind.space/zh/auth/callback/'
const HANDOFF_SCHEMES = new Set(['gugu:', 'gugu-beta:', 'gugu-dev:'])
export const isOAuthAttemptId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)

export function oauthAttemptRedirect(base: string, attempt: string): string {
  if (!isOAuthAttemptId(attempt)) throw new Error('Invalid OAuth attempt identifier')
  const url = new URL(base)
  url.searchParams.set(OAUTH_ATTEMPT_PARAM, attempt)
  return url.href
}
export function readOAuthAttempt(raw: string, base: string): string | null {
  try {
    const url = new URL(raw), expected = new URL(base)
    if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.username || url.password) return null
    const values = url.searchParams.getAll(OAUTH_ATTEMPT_PARAM)
    return values.length === 1 && isOAuthAttemptId(values[0]) ? values[0] : null
  } catch { return null }
}
export function isOAuthAttemptRedirect(raw: string, base: string): boolean {
  try {
    const url = new URL(raw)
    if (readOAuthAttempt(raw, base) !== null) return !url.hash && [...url.searchParams.keys()].length === 1
    const expected = new URL(base), handoff = new URL(OAUTH_HANDOFF_URL)
    const attempt = url.searchParams.get(OAUTH_ATTEMPT_PARAM)
    return HANDOFF_SCHEMES.has(expected.protocol) && expected.host === 'auth' && expected.pathname === '/callback'
      && !expected.username && !expected.password && !expected.search && !expected.hash
      && url.origin === handoff.origin && url.pathname === handoff.pathname && !url.username && !url.password && !url.hash
      && [...url.searchParams.keys()].length === 2 && url.searchParams.getAll('scheme').length === 1
      && url.searchParams.get('scheme') === expected.protocol.slice(0, -1)
      && url.searchParams.getAll(OAUTH_ATTEMPT_PARAM).length === 1 && isOAuthAttemptId(attempt)
      && raw === `${OAUTH_HANDOFF_URL}?scheme=${expected.protocol.slice(0, -1)}&${OAUTH_ATTEMPT_PARAM}=${attempt}`
  } catch { return false }
}

/** Only the outbound browser leg changes; native delivery/PKCE keep one attempt. */
export function oauthHandoffRedirect(native: string): string {
  const callback = new URL(native), base = `${callback.protocol}//auth/callback`
  if (!HANDOFF_SCHEMES.has(callback.protocol) || !isOAuthAttemptRedirect(native, base)) throw new Error('Invalid OAuth attempt callback')
  const url = new URL(OAUTH_HANDOFF_URL)
  url.searchParams.set('scheme', callback.protocol.slice(0, -1))
  url.searchParams.set(OAUTH_ATTEMPT_PARAM, callback.searchParams.get(OAUTH_ATTEMPT_PARAM)!)
  return url.href
}
