import type { User, UserIdentity } from '@supabase/supabase-js'

export const ACCOUNT_REVERIFICATION_MS = 10 * 60_000
export type LoginMethodChange = 'google-linked' | 'google-unlinked'
export type LoginMethodNotice = { id: string; kind: LoginMethodChange; at: string }
export const LOGIN_METHOD_NOTICE_KEY = 'gugu_login_method_change'

export class AccountLinkingError extends Error {
  constructor(readonly code: 'ownerChanged' | 'verifyRequired' | 'sameEmail' | 'alreadyLinked' | 'missingGoogle' | 'invalidEmail' | 'unsupportedIdentities' | 'signOutFailed' | 'occupied' | 'linkingUnavailable' | 'googleCancelled' | 'googleFailed' | 'googleEmailUnavailable') {
    super(code)
  }
}

export function loginMethods(user: User): { email: string; emailIdentity: UserIdentity | null; google: UserIdentity | null; googleEmail: string } {
  const identities = user.identities?.filter(identity => identity.provider === 'google') ?? []
  if (identities.length > 1) throw new AccountLinkingError('unsupportedIdentities')
  const google = identities[0] ?? null
  return { email: user.email ?? '', emailIdentity: user.identities?.find(identity => identity.provider === 'email') ?? null,
    google, googleEmail: typeof google?.identity_data?.email === 'string' ? google.identity_data.email : '' }
}

function fingerprint(user: User): string {
  const { email, emailIdentity, google } = loginMethods(user)
  return JSON.stringify([user.id, email.toLowerCase(), emailIdentity?.identity_id ?? null, google?.id ?? null, google?.identity_id ?? null])
}

export function loginMethodNotice(user: User): LoginMethodNotice | null {
  const value: unknown = user.user_metadata[LOGIN_METHOD_NOTICE_KEY]
  if (!value || typeof value !== 'object') return null
  const notice = value as Partial<LoginMethodNotice>
  return typeof notice.id === 'string' && typeof notice.at === 'string' && Number.isFinite(Date.parse(notice.at))
    && ['google-linked', 'google-unlinked'].includes(notice.kind ?? '') ? notice as LoginMethodNotice : null
}

export interface AccountLinkingDeps {
  currentUserId(): string | null
  getUser(): Promise<User>
  requestEmailOtp(email: string): Promise<void>
  verifyEmailOtp(email: string, token: string): Promise<User>
  reverifyGoogle(): Promise<User>
  linkGoogle(): Promise<User>
  changeEmail(email: string): Promise<User>
  confirmEmail(email: string, token: string): Promise<User | null>
  unlinkGoogle(identity: UserIdentity): Promise<void>
  pendingUnlink(): boolean
  recordChange(kind: LoginMethodChange): Promise<boolean>
  signOutAll(): Promise<void>
  now?(): number
}

/** These are client workflow rules. GoTrue's native APIs do not enforce this product policy. */
export class AccountLinking {
  private proof: { fingerprint: string; at: number } | null = null
  private disposed = false
  private readonly now: () => number
  constructor(private readonly userId: string, private readonly deps: AccountLinkingDeps) { this.now = deps.now ?? Date.now }
  dispose(): void { this.disposed = true; this.proof = null }
  private assertOwner(user?: User): void {
    if (this.disposed || this.deps.currentUserId() !== this.userId || (user && user.id !== this.userId))
      throw new AccountLinkingError('ownerChanged')
  }
  async read(): Promise<User> {
    this.assertOwner()
    const user = await this.deps.getUser()
    this.assertOwner(user)
    loginMethods(user)
    return user
  }
  async requestVerification(): Promise<void> {
    const { email, emailIdentity } = loginMethods(await this.read())
    if (!emailIdentity) throw new AccountLinkingError('verifyRequired')
    if (!email) throw new AccountLinkingError('invalidEmail')
    await this.deps.requestEmailOtp(email)
    this.assertOwner()
  }
  async verifyEmail(token: string): Promise<void> {
    const before = await this.read()
    if (!loginMethods(before).emailIdentity) throw new AccountLinkingError('verifyRequired')
    const verified = await this.deps.verifyEmailOtp(loginMethods(before).email, token)
    this.assertOwner(verified)
    const after = await this.read()
    if (fingerprint(after) !== fingerprint(before)) throw new AccountLinkingError('verifyRequired')
    this.proof = { fingerprint: fingerprint(after), at: this.now() }
  }
  async verifyGoogle(): Promise<void> {
    const before = await this.read()
    const google = loginMethods(before).google
    if (!google) throw new AccountLinkingError('missingGoogle')
    const verified = await this.deps.reverifyGoogle()
    this.assertOwner(verified)
    if (loginMethods(verified).google?.id !== google.id) throw new AccountLinkingError('ownerChanged')
    const after = await this.read()
    if (fingerprint(after) !== fingerprint(before)) throw new AccountLinkingError('verifyRequired')
    this.proof = { fingerprint: fingerprint(after), at: this.now() }
  }
  private async verified(): Promise<User> {
    const user = await this.read(), age = this.proof ? this.now() - this.proof.at : -1
    if (!this.proof || age < 0 || age >= ACCOUNT_REVERIFICATION_MS || this.proof.fingerprint !== fingerprint(user)) {
      this.proof = null
      throw new AccountLinkingError('verifyRequired')
    }
    return user
  }
  async linkGoogle(): Promise<boolean> {
    if (loginMethods(await this.verified()).google) throw new AccountLinkingError('alreadyLinked')
    const linked = await this.deps.linkGoogle()
    this.assertOwner(linked)
    if (!loginMethods(linked).google) throw new AccountLinkingError('missingGoogle')
    this.proof = null
    return this.deps.recordChange('google-linked')
  }
  async changeEmail(raw: string): Promise<{ email: string; complete: boolean; noticeSaved: boolean }> {
    const user = await this.verified(), email = raw.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountLinkingError('invalidEmail')
    if (email === user.email?.toLowerCase()) throw new AccountLinkingError('sameEmail')
    const changed = await this.deps.changeEmail(email)
    this.assertOwner(changed)
    const complete = changed.email?.toLowerCase() === email
    if (complete) this.proof = null
    return { email, complete, noticeSaved: true }
  }
  async confirmEmail(email: string, token: string, sourceEmail = email): Promise<{ complete: boolean; noticeSaved: boolean }> {
    const user = await this.verified()
    if (![email.toLowerCase(), user.email?.toLowerCase()].includes(sourceEmail.toLowerCase())) throw new AccountLinkingError('invalidEmail')
    const changed = await this.deps.confirmEmail(sourceEmail, token)
    this.assertOwner(changed ?? undefined)
    if (!changed || changed.email?.toLowerCase() !== email.toLowerCase()) return { complete: false, noticeSaved: true }
    this.proof = null
    return { complete: true, noticeSaved: true }
  }
  async unlinkGoogle(): Promise<void> {
    const { email, emailIdentity, google, googleEmail } = loginMethods(await this.verified())
    if (!google) throw new AccountLinkingError('missingGoogle')
    if (!googleEmail) throw new AccountLinkingError('googleEmailUnavailable')
    if (!emailIdentity || !email || email.toLowerCase() === googleEmail.toLowerCase()) throw new AccountLinkingError('sameEmail')
    await this.deps.unlinkGoogle(google)
    // The mutation has committed. Closing settings or selecting another account must
    // never cancel cleanup of the account whose Google identity was removed.
    this.proof = null
    // Failure to save an informational notice must not prevent session revocation.
    try { await this.deps.recordChange('google-unlinked') } finally { await this.finishUnlink() }
  }
  async finishUnlink(): Promise<void> {
    if (!this.hasPendingUnlink()) throw new AccountLinkingError('missingGoogle')
    await this.deps.signOutAll()
  }
  hasPendingUnlink(): boolean { return this.deps.pendingUnlink() }
}
