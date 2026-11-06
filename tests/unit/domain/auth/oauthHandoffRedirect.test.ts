import { describe, expect, it } from 'vitest'
import { isOAuthAttemptRedirect, oauthAttemptRedirect, oauthHandoffRedirect } from '../../../../apps/desktop/shared/oauth-attempt'
import { parseOAuthCallback } from '../../../../apps/desktop/shared/oauth-callback'
import { googleAuthorizationUrl } from '../../../../apps/desktop/shared/google-authorization-url'

const attempt = '11111111-2222-4333-8444-555555555555'
describe('HTTPS handoff keeps the existing native attempt and owner', () => {
  it.each(['gugu', 'gugu-beta', 'gugu-dev'])('binds %s to the same native callback channel', scheme => {
    const base = `${scheme}://auth/callback`, native = oauthAttemptRedirect(base, attempt)
    const https = oauthHandoffRedirect(native)
    expect(https).toBe(`https://gugu.nextmind.space/zh/auth/callback/?scheme=${scheme}&gugu_oauth_attempt=${attempt}`)
    expect(isOAuthAttemptRedirect(https, base)).toBe(true)
    expect(isOAuthAttemptRedirect(native, base)).toBe(true)
    expect(parseOAuthCallback(`${native}&code=FAKE_TEST`, base)).toEqual({ kind: 'code', code: 'FAKE_TEST' })
    expect(parseOAuthCallback(`${native}&error=access_denied#error=access_denied&sb=`, base)).toEqual({ kind: 'cancelled' })
    const authorization = `https://auth.example.test/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(https)}&code_challenge=challenge`
    expect(googleAuthorizationUrl(authorization, 'https://auth.example.test', https)).toBe(authorization)
  })
  const native = oauthAttemptRedirect('gugu-beta://auth/callback', attempt)
  const https = oauthHandoffRedirect(native)
  it.each([
    https.replace('https:', 'http:'), https.replace('gugu.nextmind.space', 'example.invalid'),
    https.replace('/zh/auth/callback/', '/zh/auth/callbackevil/'), https.replace('/callback/', '/callback'),
    https.replace('scheme=gugu-beta', 'scheme=gugu'), https.replace(attempt, 'bad-uuid'),
    `${https}&scheme=gugu-beta`, `${https}&gugu_oauth_attempt=${attempt}`, `${https}&extra=FAKE_TEST`,
    `${https}#error=access_denied`, https.replace('https://', 'https://user@'),
    https.replace('gugu.nextmind.space/', 'gugu.nextmind.space:443/'),
    https.replace(`scheme=gugu-beta&gugu_oauth_attempt=${attempt}`, `gugu_oauth_attempt=${attempt}&scheme=gugu-beta`),
    https.replace(attempt, '%31' + attempt.slice(1)),
  ])('rejects a mismatched HTTPS target at the existing IPC guard: %s', raw => {
    expect(isOAuthAttemptRedirect(raw, 'gugu-beta://auth/callback')).toBe(false)
  })
  it.each([
    native.replace('gugu-beta:', 'https:'), native.replace('//auth/', '//other/'),
    native.replace('/callback?', '/else?'), native.replace(attempt, 'invalid'),
    `${native}&extra=value`, `${native}#fragment`,
  ])('does not convert an arbitrary native endpoint: %s', raw => {
    expect(() => oauthHandoffRedirect(raw)).toThrow()
  })
})
