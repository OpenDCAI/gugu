import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultDisk } from '../../../apps/desktop/electron/password-vault/disk'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { VaultError, type VaultDependencies, type VaultUseBinding, type VaultUseCapability, type VaultUseControl, type VaultSinkControl } from '../../../apps/desktop/electron/password-vault/contracts'

const disposals: LocalPasswordVault[] = [], roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const vault of disposals.splice(0)) await vault.dispose().catch(() => undefined); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function scenario() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-sink-canary-')); roots.push(root)
  const owner = randomUUID(), person = {}, actor = {}, key = randomBytes(32), issued = new WeakMap<object, { binding: VaultUseBinding; claimed: boolean; submitted: boolean; abort: AbortController }>()
  const controllers: AbortController[] = []
  const fill = vi.fn(async (_binding: VaultUseBinding, _secrets: { account: Buffer; password: Buffer }, control: VaultSinkControl) => { control.assertCurrent(); await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed' as const })
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }))
  const dependencies: VaultDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error() }, assertOwnedLocalAgent: context => { if (context !== actor) throw new Error() },
    assertPrivateStorageReady: vi.fn(async () => undefined), assertFeatureReady: vi.fn(async () => undefined),
    keys: { verifyPerson: async () => undefined, wrap: async (value, binding) => JSON.stringify(seal(key, value, binding)), unwrap: async (value, binding) => unseal(key, JSON.parse(value), binding) },
    invalidate: vi.fn(async () => { for (const controller of controllers) controller.abort() }),
    browser: { fillAndSubmit: fill, cleanup,
      claimCredentialSink(capability, binding) {
        const use = issued.get(capability)
        if (!use || use.claimed || JSON.stringify(use.binding) !== JSON.stringify(binding)) throw new VaultError('UNAVAILABLE')
        use.claimed = true
        return { signal: use.abort.signal, assertCurrent: () => { if (use.abort.signal.aborted) throw new VaultError('CANCELLED') },
          claimSubmission: () => { if (use.submitted || use.abort.signal.aborted) throw new VaultError('CANCELLED'); use.submitted = true } }
      } },
  }
  const vault = new LocalPasswordVault(dependencies); disposals.push(vault)
  const recovery = await vault.beginSetup(person); await vault.confirmRecovery(person, recovery.setupId, recovery.recoveryMaterial)
  const input = { origin: 'https://login.example.test:8443', account: randomBytes(24).toString('base64url'), password: randomBytes(48).toString('base64url') }
  const saved = await vault.save(person, randomUUID(), input)
  const checked = await vault.checkReference(actor, saved.reference)
  if (checked.status !== 'valid') throw new Error('synthetic fixture not ready')
  const binding: VaultUseBinding = { accountId: owner, installationId: checked.installationId, agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(), loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), frameId: randomUUID(), documentId: randomUUID(), formFingerprint: 'synthetic-form',
    credentialId: saved.reference.id, credentialVersion: String(saved.reference.version), lockEpoch: saved.reference.epoch, origin: input.origin, operation: 'login-submit', requestId: randomUUID(), useId: randomUUID() }
  function issue(value = binding): VaultUseCapability {
    const capability = {} as VaultUseCapability, abort = new AbortController(); controllers.push(abort)
    issued.set(capability, { binding: value, claimed: false, submitted: false, abort }); return capability
  }
  return { vault, owner, person, actor, input, saved, binding, issue, fill, cleanup, dependencies }
}

describe('trusted internal browser sink with synthetic authority', () => {
  it('releases buffers only after pre-audit, claims once, and clears buffers and late submission rights', async () => {
    const { vault, binding, issue, fill, person, input } = await scenario(), capability = issue()
    let account!: Buffer, password!: Buffer, control!: VaultUseControl, matched = false
    fill.mockImplementationOnce(async (_bound, secrets, lease) => {
      account = secrets.account; password = secrets.password; control = lease
      const recorded = await vault.readAudit(person)
      expect(recorded.some(record => record.action === 'use' && record.outcome === 'pending')).toBe(true)
      matched = password.equals(Buffer.from(input.password)); lease.assertCurrent(); await lease.prepareSubmission(); lease.claimSubmission()
      expect(() => lease.claimSubmission()).toThrow(VaultError)
      return 'submitted_unconfirmed'
    })
    const outcome = await vault.useCredential(capability, binding)
    expect(outcome).toEqual({ status: 'submitted_unconfirmed', retry: false, retainIsolatedLogin: false }); expect(matched).toBe(true)
    expect(account.every(byte => byte === 0)).toBe(true); expect(password.every(byte => byte === 0)).toBe(true)
    expect(() => control.claimSubmission()).toThrow(VaultError)
    expect((await vault.useCredential(capability, binding)).status).toBe('unavailable'); expect(fill).toHaveBeenCalledOnce()
  })
  it('rejects serialized/forged capabilities and mismatched owner/site/version before releasing secrets', async () => {
    const { vault, binding, issue, fill } = await scenario()
    expect((await vault.useCredential({} as VaultUseCapability, binding)).status).toBe('unavailable')
    for (const changed of [{ ...binding, accountId: randomUUID() }, { ...binding, origin: 'https://sibling.example.test' }, { ...binding, credentialVersion: '01' }]) {
      expect((await vault.useCredential(issue(changed), changed)).status).toBe('unavailable')
    }
    expect(fill).not.toHaveBeenCalled()
  })
  it('requires a fresh actual-actor reference check and reports lock/old-version invalidation', async () => {
    const { vault, saved, actor, person } = await scenario()
    expect((await vault.checkReference({}, saved.reference)).status).toBe('unavailable')
    await vault.save(person, randomUUID(), { origin: 'https://login.example.test:8443', account: randomUUID(), password: randomUUID() }, saved.reference)
    expect((await vault.checkReference(actor, saved.reference)).status).toBe('invalidated')
    await vault.lock(); expect((await vault.checkReference(actor, saved.reference)).status).toBe('locked')
  })
  it('does not call the sink when the pre-use audit fails and retains the isolated login surface', async () => {
    const { vault, binding, issue, fill, cleanup } = await scenario(), original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/')) throw new Error('synthetic raw error'); return original.call(this, path, bytes) })
    expect(await vault.useCredential(issue(), binding)).toEqual({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    expect(fill).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce()
  })
  it('keeps post-effect audit failure uncertain, with no retry or isolated-surface handoff', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/') && ++writes === 3) throw new Error('synthetic page echo'); return original.call(this, path, bytes) })
    expect(await vault.useCredential(issue(), binding)).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
    expect(fill).toHaveBeenCalledOnce(); expect(vault.state().status).toBe('unavailable')
  })
  it('blocks a submission when audit fails between filling and claiming the submission', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0, submissions = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/') && ++writes === 2) throw new Error('synthetic pre-submit failure'); return original.call(this, path, bytes) })
    fill.mockImplementationOnce(async (_bound, _secrets, control) => {
      // Optional only in this regression instrument: the reviewed baseline lacks the new method.
      await control.prepareSubmission?.(); control.claimSubmission(); submissions += 1; return 'submitted_unconfirmed'
    })
    const outcome = await vault.useCredential(issue(), binding)
    // Test the observed effect outside the sink: exceptions inside the sink are deliberately sanitized.
    expect(submissions).toBe(0)
    expect(outcome).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
  })
  it('cannot revive a use when a pre-submit audit receipt completes after lock', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0, releaseWrite!: () => void, submissions = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/') && ++writes === 2) await new Promise<void>(resolve => { releaseWrite = resolve })
      return original.call(this, path, bytes)
    })
    fill.mockImplementationOnce(async (_bound, _secrets, control) => { await control.prepareSubmission(); control.claimSubmission(); submissions += 1; return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding)
    await vi.waitFor(() => expect(typeof releaseWrite).toBe('function'))
    const locking = vault.lock('os-lock'); releaseWrite()
    expect((await using).status).toBe('uncertain'); await locking
    expect(submissions).toBe(0)
  })
  it('zeroes live buffers synchronously on lock and rejects a later submission', async () => {
    const { vault, binding, issue, fill } = await scenario()
    let password!: Buffer, submit!: () => void, release!: () => void
    fill.mockImplementationOnce(async (_bound, secrets, control) => { password = secrets.password; submit = control.claimSubmission; await new Promise<void>(resolve => { release = resolve }); control.claimSubmission(); return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding)
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    const locking = vault.lock(); expect(password.every(byte => byte === 0)).toBe(true); expect(() => submit()).toThrow(VaultError)
    release(); expect((await using).status).toBe('uncertain'); await locking
  })
  it('invalidates an edit immediately and waits for in-flight cleanup before reporting saved', async () => {
    const { vault, binding, issue, fill, cleanup, dependencies, saved, person } = await scenario()
    let password!: Buffer, release!: () => void, confirmCleanup!: () => void
    const cleaned = new Promise<void>(resolve => { confirmCleanup = resolve })
    vi.mocked(dependencies.invalidate).mockImplementationOnce(async () => cleaned)
    cleanup.mockImplementationOnce(async () => { confirmCleanup(); return { status: 'cleaned' } })
    fill.mockImplementationOnce(async (_bound, secrets, control) => { password = secrets.password; await new Promise<void>(resolve => { release = resolve }); control.claimSubmission(); return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding); await vi.waitFor(() => expect(typeof release).toBe('function'))
    const editing = vault.save(person, randomUUID(), { origin: binding.origin, account: randomUUID(), password: randomUUID() }, saved.reference)
    expect(password.every(byte => byte === 0)).toBe(true)
    release(); expect((await using).status).toBe('uncertain'); expect((await editing).reference.version).toBe(2)
  })
  it('does not interpret cleaned as authority to hand back the isolated surface, and keeps unresolved cleanup isolated', async () => {
    const { vault, binding, issue, cleanup } = await scenario()
    cleanup.mockResolvedValueOnce({ status: 'isolated_login_retained' } as never)
    const result = await vault.useCredential(issue(), binding)
    expect(result.retainIsolatedLogin).toBe(true)
  })
})
