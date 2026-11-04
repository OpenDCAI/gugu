import { createHash } from 'node:crypto'
import type { Session } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createGuguSupabaseClient } from '../../../../packages/core/src/cloud/supabase'
import { isOAuthCallback, parseOAuthCallback } from '../../../../apps/desktop/shared/oauth-callback'
import { OpenedLinkInbox } from '../../../../apps/desktop/shared/opened-link-inbox'
import { OAuthCallbackInbox } from '../../../../apps/desktop/electron/oauth-callback-inbox'

const redirectTo = 'gugu-beta://auth/callback'
const verifierKey = 'sb-main-code-verifier'
const existingUserId = '92967f1c-6d19-4d92-a2d0-e38caf7377b7'
const session: Session = {
  access_token: 'google-access-token', refresh_token: 'google-refresh-token', token_type: 'bearer', expires_in: 3600,
  user: { id: existingUserId, email: 'verified@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
    aud: 'authenticated', app_metadata: { providers: ['email', 'google'] }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
}
function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
describe('OAuth callback boundary', () => {
  it.each(['gugu', 'gugu-beta', 'gugu-dev'])('parses only the originating %s channel', (scheme) => {
    expect(parseOAuthCallback(`${scheme}://auth/callback?code=opaque%2Bcode`, `${scheme}://auth/callback`)).toEqual({ kind: 'code', code: 'opaque+code' })
    const other = scheme === 'gugu' ? 'gugu-beta' : 'gugu'
    expect(parseOAuthCallback(`${other}://auth/callback?code=opaque`, `${scheme}://auth/callback`)).toEqual({ kind: 'invalid' })
  })
  it.each([
    'https://auth/callback?code=x', 'gugu-beta://auth.evil/callback?code=x', 'gugu-beta://auth/callback/?code=x',
    'gugu-beta://user@auth/callback?code=x', 'gugu-beta://auth:9/callback?code=x', 'gugu-beta://auth/callback',
    'gugu-beta://auth/callback?code=', 'gugu-beta://auth/callback?code=a&code=b',
    'gugu-beta://auth/callback?code=a&error=access_denied', 'gugu-beta://auth/callback#access_token=secret',
    'gugu-beta://auth/callback?code=a#code=b', 'gugu-beta://auth/callback?error=access_denied#error=server_error',
    'gugu-beta://auth/callback#error=access_denied&access_token=secret',
  ])('rejects malformed, ambiguous and implicit-flow URLs: %s', (url) => {
    expect(parseOAuthCallback(url, redirectTo)).toEqual({ kind: 'invalid' })
  })
  it('recognises GoTrue query + legacy fragment cancellation without exposing its description', () => {
    expect(parseOAuthCallback(`${redirectTo}?error=access_denied#error=access_denied&error_description=private&sb=`, redirectTo)).toEqual({ kind: 'cancelled' })
    expect(parseOAuthCallback(`${redirectTo}#error=access_denied`, redirectTo)).toEqual({ kind: 'cancelled' })
    expect(parseOAuthCallback(`${redirectTo}?error=access_denied&error_code=user_banned`, redirectTo)).toEqual({ kind: 'error', code: 'user_banned' })
  })
  it('keeps every reserved auth URL away from extension navigation, including malformed paths', () => {
    expect(isOAuthCallback('gugu-beta://auth/wrong-path?code=secret')).toBe(true)
    const inbox = new OpenedLinkInbox()
    const auth = vi.fn(), navigation = vi.fn()
    inbox.push(`${redirectTo}?code=cold`)
    inbox.push('gugu-beta://ext/notes/main')
    inbox.subscribe('auth', auth)
    expect(auth).toHaveBeenCalledExactlyOnceWith(`${redirectTo}?code=cold`)
    expect(navigation).not.toHaveBeenCalled()
    inbox.subscribe('navigation', navigation)
    expect(navigation).toHaveBeenCalledExactlyOnceWith('gugu-beta://ext/notes/main')
  })
  it('retains desktop callbacks until the renderer takes them, across cold/window reload boundaries', () => {
    const notify = vi.fn(), inbox = new OAuthCallbackInbox(notify)
    inbox.push(`${redirectTo}?code=cold`)
    expect(notify).toHaveBeenCalledOnce()
    expect(inbox.take()).toEqual([`${redirectTo}?code=cold`])
    expect(inbox.take()).toEqual([])
  })
})

it('uses the actual Supabase PKCE storage and exchange wire format without writing an auth session or a profile', async () => {
  const storage = memoryStorage()
  const sdkStorage = {
    getItem: storage.getItem,
    setItem: (key: string, value: string) => { if (key === verifierKey) storage.setItem(key, value) },
    removeItem: (key: string) => { if (key === verifierKey) storage.removeItem(key) },
  }
  const fetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  const options = { url: 'https://auth.example.test', anonKey: 'public-test-key', storage: sdkStorage, storageKey: 'sb-main',
    persistSession: true, autoRefreshToken: false, flowType: 'pkce' as const, fetch }
  const first = createGuguSupabaseClient(options)
  const authorization = await first.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } })
  expect(authorization.error).toBeNull()
  const url = new URL(authorization.data.url!)
  const verifier = JSON.parse(storage.getItem(verifierKey)!) as string
  expect(url.searchParams.get('redirect_to')).toBe(redirectTo)
  expect(url.searchParams.get('code_challenge_method')).toBe('s256')
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier.split('/')[0]!).digest('base64url'))
  // Fresh client simulates native process restart: only the originating local verifier survives.
  const restored = createGuguSupabaseClient(options)
  const exchanged = await restored.auth.exchangeCodeForSession('returned-code')
  expect(exchanged.error).toBeNull()
  expect(exchanged.data.session?.user.id).toBe(existingUserId)
  expect(fetch).toHaveBeenCalledOnce()
  const [request, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(request).toBe('https://auth.example.test/auth/v1/token?grant_type=pkce')
  expect(JSON.parse(init.body as string)).toMatchObject({ auth_code: 'returned-code', code_verifier: verifier.split('/')[0] })
  expect(storage.values.size).toBe(0)
  await first.auth.stopAutoRefresh()
  await restored.auth.stopAutoRefresh()
})
