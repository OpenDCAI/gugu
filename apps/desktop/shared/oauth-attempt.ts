export const OAUTH_ATTEMPT_PARAM = 'gugu_oauth_attempt'
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
  if (readOAuthAttempt(raw, base) === null) return false
  const url = new URL(raw)
  return !url.hash && [...url.searchParams.keys()].length === 1
}
