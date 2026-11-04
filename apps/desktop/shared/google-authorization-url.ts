/** Shared URL validation also runs at the Electron IPC boundary before shell.openExternal. */
export function googleAuthorizationUrl(raw: string, supabaseUrl: string, redirectTo: string): string {
  const url = new URL(raw)
  const expected = new URL(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize`)
  if (!['http:', 'https:'].includes(expected.protocol) || url.origin !== expected.origin || url.pathname !== expected.pathname
    || url.username || url.password || url.hash || url.searchParams.getAll('provider').length !== 1
    || url.searchParams.get('provider') !== 'google' || url.searchParams.getAll('redirect_to').length !== 1
    || url.searchParams.get('redirect_to') !== redirectTo || !url.searchParams.get('code_challenge'))
    throw new Error('Invalid Google authorization URL')
  return url.href
}
