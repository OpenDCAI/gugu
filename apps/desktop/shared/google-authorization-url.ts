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

/** Manual linking returns Google's URL, with the native return path retained in GoTrue state. */
export function googleIdentityLinkUrl(raw: string, supabaseUrl: string): string {
  const url = new URL(raw)
  const callback = new URL(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/callback`)
  if (url.origin !== 'https://accounts.google.com' || !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname)
    || url.username || url.password || url.hash
    || url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== callback.href
    || url.searchParams.getAll('response_type').length !== 1 || url.searchParams.get('response_type') !== 'code'
    || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')
    || url.searchParams.getAll('client_id').length !== 1 || !url.searchParams.get('client_id'))
    throw new Error('Invalid Google identity linking URL')
  return url.href
}
