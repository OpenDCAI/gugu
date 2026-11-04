/** OAuth URLs carry credentials. Never pass them to navigation, logs, or extension handlers. */
export function isOAuthCallback(raw: string): boolean {
  try {
    const url = new URL(raw)
    return /^gugu(?:-[a-z0-9-]+)?:$/.test(url.protocol) && url.hostname === 'auth'
  } catch { return false }
}

export type OAuthCallback =
  | { kind: 'code'; code: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: string }
  | { kind: 'invalid' }

export function parseOAuthCallback(raw: string, redirectTo: string): OAuthCallback {
  if (!isOAuthCallback(raw)) return { kind: 'invalid' }
  const url = new URL(raw)
  const expected = new URL(redirectTo)
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.username || url.password)
    return { kind: 'invalid' }
  const codes = url.searchParams.getAll('code')
  const errors = url.searchParams.getAll('error')
  // GoTrue sends OAuth failures in the query AND a legacy fragment. Accept that documented
  // failure shape, while never accepting implicit-flow tokens or a code hidden in a fragment.
  const fragment = new URLSearchParams(url.hash.slice(1))
  const fragmentErrors = fragment.getAll('error')
  if (codes.length > 1 || errors.length > 1 || fragmentErrors.length > 1
    || (errors[0] && fragmentErrors[0] && errors[0] !== fragmentErrors[0])
    || (url.hash && !fragmentErrors[0]) || fragment.has('access_token') || fragment.has('code')) return { kind: 'invalid' }
  const error = errors[0] ?? fragmentErrors[0]
  if (codes.length && error) return { kind: 'invalid' }
  if (error) {
    const code = url.searchParams.get('error_code') ?? fragment.get('error_code')
    return error === 'access_denied' && !code ? { kind: 'cancelled' } : { kind: 'error', code: code ?? error }
  }
  return codes[0]?.trim() ? { kind: 'code', code: codes[0] } : { kind: 'invalid' }
}
