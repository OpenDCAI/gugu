import { describe, expect, it, vi } from 'vitest'
import type { User, UserIdentity } from '@supabase/supabase-js'
import { AccountLinking, ACCOUNT_REVERIFICATION_MS, loginMethodNotice, loginMethods, type AccountLinkingDeps } from '../../../../apps/desktop/src/lib/accountLinking'
import { googleIdentityLinkUrl } from '../../../../apps/desktop/shared/google-authorization-url'

const google: UserIdentity = { id: 'google-subject', identity_id: 'identity-id', provider: 'google', user_id: 'alice', created_at: '', updated_at: '', identity_data: { email: 'google@example.test' } }
const emailIdentity: UserIdentity = { ...google, id: 'alice', identity_id: 'email-identity-id', provider: 'email', identity_data: { email: 'alice@example.test' } }
function user(patch: Partial<User> = {}): User {
  return { id: 'alice', email: 'alice@example.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '', identities: [emailIdentity], ...patch }
}
function harness(initial = user()) {
  let current = initial, currentOwner: string | null = initial.id, now = 1_000, pendingUnlink = false
  const deps: AccountLinkingDeps = {
    currentUserId: () => currentOwner,
    getUser: vi.fn(async () => current),
    requestEmailOtp: vi.fn(async () => {}),
    verifyEmailOtp: vi.fn(async () => current),
    reverifyGoogle: vi.fn(async () => current),
    linkGoogle: vi.fn(async () => { current = { ...current, identities: [emailIdentity, google] }; return current }),
    changeEmail: vi.fn(async () => current),
    confirmEmail: vi.fn(async () => null),
    unlinkGoogle: vi.fn(async () => { current = { ...current, identities: [emailIdentity] }; pendingUnlink = true }),
    pendingUnlink: () => pendingUnlink,
    recordChange: vi.fn(async () => true),
    signOutAll: vi.fn(async () => {}),
    now: () => now,
  }
  return { deps, flow: new AccountLinking(initial.id, deps), setUser: (value: User) => { current = value }, setOwner: (value: string | null) => { currentOwner = value }, advance: (ms: number) => { now += ms } }
}

describe('account linking workflow', () => {
  it('does not offer a Google-only account email OTP verification before an email identity exists', async () => {
    const h = harness(user({ identities: [google] }))
    expect(loginMethods(await h.flow.read()).emailIdentity).toBeNull()
    await expect(h.flow.requestVerification()).rejects.toMatchObject({ code: 'verifyRequired' })
    await expect(h.flow.verifyEmail('123456')).rejects.toMatchObject({ code: 'verifyRequired' })
    expect(h.deps.requestEmailOtp).not.toHaveBeenCalled()
    expect(h.deps.verifyEmailOtp).not.toHaveBeenCalled()
    await h.flow.verifyGoogle()
    await expect(h.flow.changeEmail('new@example.test')).resolves.toMatchObject({ complete: false })
    await expect(h.flow.unlinkGoogle()).rejects.toMatchObject({ code: 'sameEmail' })
  })
  it('uses email OTP for an email-only account and refuses Google reauthorization', async () => {
    const h = harness()
    await h.flow.requestVerification()
    expect(h.deps.requestEmailOtp).toHaveBeenCalledExactlyOnceWith('alice@example.test')
    await h.flow.verifyEmail('123456')
    await expect(h.flow.verifyGoogle()).rejects.toMatchObject({ code: 'missingGoogle' })
    expect(h.deps.reverifyGoogle).not.toHaveBeenCalled()
  })
  it.each(['email', 'google'] as const)('allows the existing %s identity when both methods are linked', async method => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await (method === 'email' ? h.flow.verifyEmail('123456') : h.flow.verifyGoogle())
    await expect(h.flow.changeEmail('new@example.test')).resolves.toMatchObject({ complete: false })
  })
  it('rejects linking, email changes and unlinking without fresh verification', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await expect(h.flow.linkGoogle()).rejects.toMatchObject({ code: 'verifyRequired' })
    await expect(h.flow.changeEmail('new@example.test')).rejects.toMatchObject({ code: 'verifyRequired' })
    await expect(h.flow.unlinkGoogle()).rejects.toMatchObject({ code: 'verifyRequired' })
    expect(h.deps.linkGoogle).not.toHaveBeenCalled()
    expect(h.deps.changeEmail).not.toHaveBeenCalled()
    expect(h.deps.unlinkGoogle).not.toHaveBeenCalled()
  })
  it('accepts verification up to the ten-minute boundary and rejects exactly ten minutes', async () => {
    const h = harness()
    await h.flow.verifyEmail('123456')
    h.advance(ACCOUNT_REVERIFICATION_MS - 1)
    await h.flow.changeEmail('new@example.test')
    h.advance(1)
    await expect(h.flow.changeEmail('next@example.test')).rejects.toMatchObject({ code: 'verifyRequired' })
    expect(h.deps.changeEmail).toHaveBeenCalledOnce()
  })
  it('invalidates verification after a backwards clock jump or changed login methods', async () => {
    const h = harness()
    await h.flow.verifyEmail('123456'); h.advance(-1)
    await expect(h.flow.linkGoogle()).rejects.toMatchObject({ code: 'verifyRequired' })
    h.advance(1); await h.flow.verifyEmail('123456')
    h.setUser(user({ email: 'elsewhere@example.test' }))
    await expect(h.flow.linkGoogle()).rejects.toMatchObject({ code: 'verifyRequired' })
  })
  it.each(['email', 'google'] as const)('never accepts a different user returned by %s verification', async method => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    if (method === 'email') vi.mocked(h.deps.verifyEmailOtp).mockResolvedValue(user({ id: 'bob' }))
    else vi.mocked(h.deps.reverifyGoogle).mockResolvedValue(user({ id: 'bob', identities: [emailIdentity, google] }))
    await expect(method === 'email' ? h.flow.verifyEmail('123456') : h.flow.verifyGoogle()).rejects.toMatchObject({ code: 'ownerChanged' })
    await expect(h.flow.changeEmail('new@example.test')).rejects.toMatchObject({ code: 'verifyRequired' })
  })
  it('checks the existing Google subject, not only the account ID', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    vi.mocked(h.deps.reverifyGoogle).mockResolvedValue(user({ identities: [{ ...google, id: 'other-google' }] }))
    await expect(h.flow.verifyGoogle()).rejects.toMatchObject({ code: 'ownerChanged' })
  })
  it('rejects late verification after logout, account switching or disposal', async () => {
    const h = harness()
    vi.mocked(h.deps.verifyEmailOtp).mockImplementation(async () => { h.setOwner('bob'); return user() })
    await expect(h.flow.verifyEmail('123456')).rejects.toMatchObject({ code: 'ownerChanged' })
    h.setOwner('alice'); h.flow.dispose()
    await expect(h.flow.read()).rejects.toMatchObject({ code: 'ownerChanged' })
  })
  it('allows different-address linking, records the actual change and consumes verification', async () => {
    const h = harness()
    await h.flow.verifyEmail('123456')
    await expect(h.flow.linkGoogle()).resolves.toBe(true)
    expect(h.deps.recordChange).toHaveBeenCalledExactlyOnceWith('google-linked')
    await expect(h.flow.changeEmail('new@example.test')).rejects.toMatchObject({ code: 'verifyRequired' })
  })
  it('rejects a second Google identity before making a linking request', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    await expect(h.flow.linkGoogle()).rejects.toMatchObject({ code: 'alreadyLinked' })
    expect(h.deps.linkGoogle).not.toHaveBeenCalled()
    expect(() => loginMethods(user({ identities: [google, { ...google, id: 'second' }] }))).toThrow()
  })
  it('preserves occupied-address/provider errors and does not record a successful change', async () => {
    const h = harness(), occupied = { code: 'identity_already_exists' }
    await h.flow.verifyEmail('123456')
    vi.mocked(h.deps.linkGoogle).mockRejectedValue(occupied)
    await expect(h.flow.linkGoogle()).rejects.toBe(occupied)
    vi.mocked(h.deps.changeEmail).mockRejectedValue({ code: 'email_exists' })
    await expect(h.flow.changeEmail('taken@example.test')).rejects.toMatchObject({ code: 'email_exists' })
    expect(h.deps.recordChange).not.toHaveBeenCalled()
  })
  it('requires a different email before unlinking a Google identity, ignoring address case', async () => {
    const h = harness(user({ email: 'GOOGLE@example.test', identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    await expect(h.flow.unlinkGoogle()).rejects.toMatchObject({ code: 'sameEmail' })
    expect(h.deps.unlinkGoogle).not.toHaveBeenCalled()
    expect(h.deps.signOutAll).not.toHaveBeenCalled()
  })
  it('waits for both secure-email confirmations without creating a defensive notice', async () => {
    const h = harness()
    await h.flow.verifyEmail('123456')
    await expect(h.flow.changeEmail(' New@example.test ')).resolves.toMatchObject({ email: 'new@example.test', complete: false })
    await expect(h.flow.confirmEmail('new@example.test', '111111')).resolves.toMatchObject({ complete: false })
    expect(h.deps.recordChange).not.toHaveBeenCalled()
    vi.mocked(h.deps.confirmEmail).mockResolvedValue(user({ email: 'new@example.test' }))
    await expect(h.flow.confirmEmail('new@example.test', '222222', 'alice@example.test')).resolves.toMatchObject({ complete: true })
    expect(h.deps.confirmEmail).toHaveBeenLastCalledWith('alice@example.test', '222222')
    expect(h.deps.recordChange).not.toHaveBeenCalled()
  })
  it('revokes all devices after unlinking, even when saving the notice fails', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    vi.mocked(h.deps.recordChange).mockRejectedValue(new Error('notice storage unavailable'))
    await expect(h.flow.unlinkGoogle()).rejects.toThrow('notice storage unavailable')
    expect(h.deps.signOutAll).toHaveBeenCalledOnce()
  })
  it('supports retrying global sign-out after an unlink that succeeded on the server', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    vi.mocked(h.deps.signOutAll).mockRejectedValueOnce(new Error('network unavailable'))
    await expect(h.flow.unlinkGoogle()).rejects.toThrow('network unavailable')
    await h.flow.finishUnlink()
    expect(h.deps.unlinkGoogle).toHaveBeenCalledOnce()
    expect(h.deps.signOutAll).toHaveBeenCalledTimes(2)
  })
  it('does not revoke other sessions when unlinking fails', async () => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    vi.mocked(h.deps.unlinkGoogle).mockRejectedValue(new Error('unlink failed'))
    await expect(h.flow.unlinkGoogle()).rejects.toThrow('unlink failed')
    expect(h.deps.signOutAll).not.toHaveBeenCalled()
  })
  it.each(['dispose', 'switch'] as const)('finishes revocation when settings %s happens while unlinking', async change => {
    const h = harness(user({ identities: [emailIdentity, google] }))
    await h.flow.verifyGoogle()
    const original = vi.mocked(h.deps.unlinkGoogle).getMockImplementation()!
    vi.mocked(h.deps.unlinkGoogle).mockImplementation(async identity => {
      if (change === 'dispose') h.flow.dispose()
      else h.setOwner('bob')
      await original(identity)
    })
    await h.flow.unlinkGoogle()
    expect(h.deps.signOutAll).toHaveBeenCalledOnce()
  })
  it('validates persisted notices before presenting them as account changes', () => {
    const valid = { id: 'change', kind: 'google-unlinked', at: '2026-11-06T12:00:00Z' }
    expect(loginMethodNotice(user({ user_metadata: { gugu_login_method_change: valid } }))).toEqual(valid)
    expect(loginMethodNotice(user({ user_metadata: { gugu_login_method_change: { ...valid, kind: 'invented' } } }))).toBeNull()
    expect(loginMethodNotice(user({ user_metadata: { gugu_login_method_change: { ...valid, kind: 'email-changed' } } }))).toBeNull()
  })
})

describe('Google linking browser boundary', () => {
  const valid = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=opaque&response_type=code&redirect_uri=https%3A%2F%2Fauth.example.test%2Fauth%2Fv1%2Fcallback'
  it('allows only the Google authorization endpoint returning to the configured GoTrue callback', () => {
    expect(googleIdentityLinkUrl(valid, 'https://auth.example.test')).toBe(valid)
  })
  it.each([
    valid.replace('accounts.google.com', 'evil.example.test'), valid.replace('/o/oauth2/v2/auth', '/logout'),
    valid.replace('auth.example.test', 'another.example.test'), `${valid}&redirect_uri=evil`, `${valid}&state=other`,
    `${valid}#secret`, valid.replace('response_type=code', 'response_type=token'), valid.replace('state=opaque', 'state='),
  ])('rejects untrusted provider URL %s', raw => {
    expect(() => googleIdentityLinkUrl(raw, 'https://auth.example.test')).toThrow()
  })
})
