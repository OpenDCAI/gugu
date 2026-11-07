import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultError, type VaultDependencies, type VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { hash, RETENTION_MS } from '../../../apps/desktop/electron/password-vault/schema'
import { VaultDisk } from '../../../apps/desktop/electron/password-vault/disk'
import { inspect } from 'node:util'
import { EventEmitter } from 'node:events'
import { installVaultLifecycle } from '../../../apps/desktop/electron/password-vault/lifecycle'

const owner = randomUUID(), person = {}, stranger = {}
const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(overrides: Partial<VaultDependencies> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-canary-')); roots.push(root)
  const wrappingKey = randomBytes(32)
  const keys: VaultKeyProtector = {
    verifyPerson: vi.fn(async () => undefined),
    wrap: vi.fn(async (key, binding) => JSON.stringify(seal(wrappingKey, key, binding))),
    unwrap: vi.fn(async (wrapped, binding) => unseal(wrappingKey, JSON.parse(wrapped), binding)),
  }
  const dependencies: VaultDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error('forged principal') },
    assertPrivateStorageReady: vi.fn(async () => undefined), assertFeatureReady: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined), keys, ...overrides }
  const vault = new LocalPasswordVault(dependencies); vaults.push(vault)
  return { root, dependencies, vault, keys }
}
async function setup(vault: LocalPasswordVault) {
  const material = await vault.beginSetup(person)
  await vault.confirmRecovery(person, material.setupId, material.recoveryMaterial)
  return material.recoveryMaterial
}
const canaryInput = () => ({ origin: 'https://login.example.test:8443', account: randomBytes(24).toString('hex'), password: randomBytes(48).toString('base64url') })
const event = () => ({ id: randomUUID(), action: 'request', source: 'policy', outcome: 'pending', agentId: randomUUID(), sessionId: randomUUID(), requestId: randomUUID() }) as const
async function bytesUnder(root: string): Promise<Buffer[]> {
  const items = await readdir(root, { withFileTypes: true })
  const arrays = await Promise.all(items.map(item => item.isDirectory() ? bytesUnder(join(root, item.name)) : readFile(join(root, item.name)).then(value => [value])))
  return arrays.flat()
}

describe('local encrypted vault: storage and lifecycle', () => {
  it('confirms recovery before setup, writes encrypted canaries, restarts locked and restores summaries', async () => {
    const { vault, dependencies, root } = await fixture(), input = canaryInput()
    const pending = await vault.beginSetup(person)
    await expect(vault.confirmRecovery(person, pending.setupId, 'wrong')).rejects.toMatchObject({ code: 'RECOVERY_INVALID' })
    await expect(vault.list(person)).rejects.toMatchObject({ code: 'LOCKED' })
    await vault.confirmRecovery(person, pending.setupId, pending.recoveryMaterial)
    const summary = await vault.save(person, randomUUID(), input)
    await writeFile(join(root, 'detector-control.txt'), 'known-nonempty-detector-control')
    const files = await bytesUnder(root)
    expect(files.some(bytes => bytes.includes('known-nonempty-detector-control'))).toBe(true)
    // The detector has an independent positive control; failures print booleans, never the canary.
    expect(Buffer.from('known-control').includes('known-control')).toBe(true)
    for (const secret of [input.password, input.account, pending.recoveryMaterial, pending.recoveryMaterial.split('.')[2]]) {
      for (const encoded of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret)]) expect(files.some(bytes => bytes.includes(encoded))).toBe(false)
    }
    expect(JSON.stringify(summary).includes(input.password)).toBe(false)
    expect(summary.maskedAccount).toBe('••••')
    await vault.dispose()
    const restarted = new LocalPasswordVault(dependencies); vaults.push(restarted)
    expect(restarted.state().status).toBe('locked')
    await restarted.unlock(person)
    const saved = await restarted.list(person)
    expect(saved[0].reference.id).toBe(summary.reference.id)
    expect(saved[0].reference.epoch === summary.reference.epoch).toBe(false)
  })
  it('retries save/edit/delete by the same operation id without replaying effects or audit events', async () => {
    const { vault } = await fixture(); await setup(vault)
    const input = canaryInput(), addId = randomUUID(), editId = randomUUID(), deleteId = randomUUID()
    const first = await vault.save(person, addId, input), again = await vault.save(person, addId, input)
    expect(again).toEqual(first); expect((await vault.list(person)).length).toBe(1)
    const changed = canaryInput(), edited = await vault.save(person, editId, changed, first.reference)
    expect(await vault.save(person, editId, changed, first.reference)).toEqual(edited)
    await expect(vault.save(person, addId, changed)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await vault.delete(person, deleteId, edited.reference); await vault.delete(person, deleteId, edited.reference)
    expect((await vault.list(person)).length).toBe(0)
    const events = await vault.readAudit(person)
    expect(events.filter(item => item.action === 'add').length).toBe(2)
    expect(events.filter(item => item.action === 'edit').length).toBe(2)
    expect(events.filter(item => item.action === 'delete').length).toBe(2)
    expect(JSON.stringify(vault).includes('ciphertext')).toBe(false)
    expect(inspect(vault).includes('ciphertext')).toBe(false)
  })
  it('rejects malformed operation ids before writing an unreadable encrypted ledger', async () => {
    const { vault } = await fixture(); await setup(vault)
    await expect(vault.save(person, 'a'.repeat(36), canaryInput())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await vault.lock(); await vault.unlock(person)
    expect((await vault.list(person)).length).toBe(0)
  })
  it.each([
    { action: 'edit', restart: false }, { action: 'delete', restart: false },
    { action: 'edit', restart: true }, { action: 'delete', restart: true },
  ] as const)('continues a pending $action after pre-audit failure with restart=$restart using the same operation id and a fresh epoch', async ({ action, restart }) => {
    const fixtureData = await fixture(); let vault = fixtureData.vault; await setup(vault)
    const originalInput = canaryInput(), replacement = canaryInput(), first = await vault.save(person, randomUUID(), originalInput), operationId = randomUUID()
    const original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/')) throw new VaultError('STORAGE_FAILED')
      return original.call(this, path, bytes)
    })
    const attempt = action === 'edit' ? vault.save(person, operationId, replacement, first.reference) : vault.delete(person, operationId, first.reference)
    await expect(attempt).rejects.toMatchObject({ code: 'AUDIT_FAILED' })
    vi.restoreAllMocks()
    if (restart) { await vault.dispose(); vault = new LocalPasswordVault(fixtureData.dependencies); vaults.push(vault) }
    await vault.unlock(person)
    const fresh = (await vault.list(person))[0].reference
    expect(fresh.epoch === first.reference.epoch).toBe(false)
    // The original approval/reference stays invalid; only the stable operation plus a fresh reference can continue.
    const stale = action === 'edit' ? vault.save(person, operationId, replacement, first.reference) : vault.delete(person, operationId, first.reference)
    await expect(stale).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    const changedVersion = { ...fresh, version: fresh.version + 1 }
    const changed = action === 'edit' ? vault.save(person, operationId, replacement, changedVersion) : vault.delete(person, operationId, changedVersion)
    await expect(changed).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    if (action === 'edit') {
      await expect(vault.save(person, operationId, canaryInput(), fresh)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      const resumed = await vault.save(person, operationId, replacement, fresh)
      expect(resumed.reference.id).toBe(first.reference.id); expect(resumed.reference.version).toBe(2)
      expect((await vault.list(person)).length).toBe(1)
    } else {
      await vault.delete(person, operationId, fresh); expect((await vault.list(person)).length).toBe(0)
    }
  })
  it('recovers a committed management effect after the completion audit failed without saving it twice', async () => {
    const { vault } = await fixture(); await setup(vault)
    const input = canaryInput(), operationId = randomUUID(), original = VaultDisk.prototype.write
    let writes = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/') && ++writes === 2) throw new VaultError('STORAGE_FAILED')
      return original.call(this, path, bytes)
    })
    await expect(vault.save(person, operationId, input)).rejects.toMatchObject({ code: 'AUDIT_FAILED' })
    vi.restoreAllMocks(); await vault.unlock(person)
    const retained = await vault.list(person); expect(retained.length).toBe(1)
    const repeated = await vault.save(person, operationId, input)
    expect(repeated.reference.id).toBe(retained[0].reference.id)
    expect(repeated.reference.version).toBe(1)
    expect((await vault.readAudit(person)).filter(item => item.action === 'add' && item.outcome === 'completed').length).toBe(1)
  })
  it('persists a pending operation digest so a failed pre-audit retry cannot change the original input', async () => {
    const { vault } = await fixture(); await setup(vault)
    const operationId = randomUUID(), input = canaryInput(), original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/')) throw new VaultError('STORAGE_FAILED')
      return original.call(this, path, bytes)
    })
    await expect(vault.save(person, operationId, input)).rejects.toMatchObject({ code: 'AUDIT_FAILED' })
    vi.restoreAllMocks(); await vault.unlock(person)
    expect((await vault.list(person)).length).toBe(0)
    await expect(vault.save(person, operationId, canaryInput())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await vault.save(person, operationId, input)
    expect((await vault.list(person)).length).toBe(1)
  })
  it('requires private-file protection and full readiness before first saving', async () => {
    const { vault, root, dependencies } = await fixture()
    vi.mocked(dependencies.assertPrivateStorageReady).mockRejectedValue(new Error('boundary unavailable'))
    await expect(vault.beginSetup(person)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect((await readdir(root)).length).toBe(0)
    vi.mocked(dependencies.assertPrivateStorageReady).mockResolvedValue()
    vi.mocked(dependencies.assertFeatureReady).mockRejectedValue(new Error('observe only'))
    await expect(vault.beginSetup(person)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect((await readdir(root)).length).toBe(0)
  })
  it('does not treat a claimed person/account as a trusted local principal', async () => {
    const { vault } = await fixture()
    expect(() => vault.beginSetup(stranger)).toThrow(VaultError)
    await setup(vault)
    expect(() => vault.readAudit({ kind: 'person', ownerId: owner })).toThrow(VaultError)
    expect(() => vault.clearAudit(stranger)).toThrow(VaultError)
  })
  it('recovers retained data after OS wrapping-key loss, and refuses wrong material without replacement', async () => {
    const { vault, dependencies, keys } = await fixture(), input = canaryInput()
    const recovery = await setup(vault); const saved = await vault.save(person, randomUUID(), input); await vault.lock()
    vi.mocked(keys.unwrap).mockRejectedValue(new Error('keychain gone'))
    await expect(vault.unlock(person)).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    const path = join(dependencies.root, hash(owner), 'vault.json'), before = await readFile(path)
    await expect(vault.recover(person, 'wrong')).rejects.toMatchObject({ code: 'RECOVERY_INVALID' })
    expect((await readFile(path)).equals(before)).toBe(true)
    await vault.recover(person, recovery)
    expect((await vault.list(person))[0].reference.id).toBe(saved.reference.id)
  })
  it('reports missing data and cannot manufacture an empty replacement from recovery material', async () => {
    const { vault, dependencies } = await fixture(); const recovery = await setup(vault); await vault.lock()
    await unlink(join(dependencies.root, hash(owner), 'vault.json'))
    await expect(vault.unlock(person)).rejects.toMatchObject({ code: 'DATA_MISSING' })
    await expect(vault.recover(person, recovery)).rejects.toMatchObject({ code: 'DATA_MISSING' })
    await expect(vault.beginSetup(person)).rejects.toMatchObject({ code: 'DATA_MISSING' })
  })
  it('refuses authenticated-ciphertext corruption and does not overwrite it', async () => {
    const { vault, dependencies } = await fixture(); await setup(vault); await vault.lock()
    const path = join(dependencies.root, hash(owner), 'vault.json'), document = JSON.parse((await readFile(path)).toString())
    const bytes = Buffer.from(document.payload.ciphertext, 'base64'); bytes[0] ^= 1; document.payload.ciphertext = bytes.toString('base64')
    await writeFile(path, JSON.stringify(document), { mode: 0o600 }); const before = await readFile(path)
    await expect(vault.unlock(person)).rejects.toMatchObject({ code: 'DATA_DAMAGED' })
    expect((await readFile(path)).equals(before)).toBe(true)
  })
  it('isolates accounts and refuses an installation binding mismatch', async () => {
    const { vault, dependencies } = await fixture(); await setup(vault); await vault.save(person, randomUUID(), canaryInput()); await vault.dispose()
    const otherAccount = new LocalPasswordVault({ ...dependencies, accountId: randomUUID() }); vaults.push(otherAccount)
    await expect(otherAccount.unlock(person)).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    await setup(otherAccount); expect((await otherAccount.list(person)).length).toBe(0); await otherAccount.dispose()
    const wrongInstallation = new LocalPasswordVault({ ...dependencies, installationBinding: randomUUID() }); vaults.push(wrongInstallation)
    await expect(wrongInstallation.unlock(person)).rejects.toMatchObject({ code: 'WRONG_INSTALLATION' })
  })
  it('invalidates old versions on edit/delete and waits for revocation/cleanup', async () => {
    const { vault, dependencies } = await fixture(); await setup(vault)
    const first = await vault.save(person, randomUUID(), canaryInput()), second = await vault.save(person, randomUUID(), canaryInput(), first.reference)
    expect(second.reference.version).toBe(2)
    await expect(vault.delete(person, randomUUID(), first.reference)).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    await vault.delete(person, randomUUID(), second.reference); expect((await vault.list(person)).length).toBe(0)
    expect(vi.mocked(dependencies.invalidate).mock.calls.map(call => call[0].reason)).toEqual(['edit', 'delete', 'delete'])
  })
  it('revokes synchronously during system verification and cannot unlock after lock races', async () => {
    const { vault, keys } = await fixture(); await setup(vault); await vault.lock()
    let release!: () => void
    vi.mocked(keys.verifyPerson).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const unlocking = vault.unlock(person)
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    const locked = vault.lock('os-lock'); expect(vault.state().status).toBe('locked'); release()
    await expect(unlocking).rejects.toMatchObject({ code: 'CANCELLED' }); await locked
    expect(vault.state().status).toBe('locked')
  })
  it('binds OS lock, suspend, logout/account-switch and app quit without auto-unlock', async () => {
    const { vault } = await fixture(); await setup(vault)
    const power = new EventEmitter(), app = Object.assign(new EventEmitter(), { quit: vi.fn() }), attention = vi.fn()
    const lifecycle = installVaultLifecycle(vault, power, app, attention)
    power.emit('lock-screen'); expect(vault.state().status).toBe('locked')
    await vault.unlock(person); power.emit('suspend'); expect(vault.state().status).toBe('locked')
    const preventDefault = vi.fn(); app.emit('before-quit', { preventDefault }); expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce()); lifecycle.remove()
  })
  it('refuses a hard-linked ciphertext even for the trusted owner path', async () => {
    const { vault, dependencies, root } = await fixture(); await setup(vault); await vault.lock()
    await link(join(dependencies.root, hash(owner), 'vault.json'), join(root, 'alias'))
    await expect(vault.unlock(person)).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
  })
})

describe('private encrypted audit and failure receipts', () => {
  it('records only structured metadata, encrypted on disk, for owner-only read/clear', async () => {
    const { vault, root } = await fixture(); await setup(vault)
    const receipt = await vault.appendAudit(event(), { effectPossible: false }); expect(receipt.status).toBe('recorded')
    const records = await vault.readAudit(person); expect(records.some(record => record.action === 'request')).toBe(true)
    expect((await bytesUnder(root)).some(bytes => bytes.includes('"action":"request"'))).toBe(false)
    await vault.clearAudit(person); expect((await vault.readAudit(person)).map(record => record.action)).toEqual(['clear'])
    await vault.lock(); await expect(vault.readAudit(person)).rejects.toMatchObject({ code: 'LOCKED' })
  })
  it('makes repeated audit event ids idempotent and rejects changed-event reuse', async () => {
    const { vault } = await fixture(); await setup(vault)
    const input = event(), first = await vault.appendAudit(input, { effectPossible: false }), second = await vault.appendAudit(input, { effectPossible: false })
    expect(second).toEqual(first)
    expect((await vault.readAudit(person)).filter(item => item.id === input.id).length).toBe(1)
    expect((await vault.appendAudit({ ...input, outcome: 'cancelled' }, { effectPossible: false })).status).toBe('unavailable')
  })
  it('lets a freshly verified owner clear damaged encrypted audit without bypassing vault authentication', async () => {
    const { vault, dependencies } = await fixture(); await setup(vault); await vault.lock()
    const directory = join(dependencies.root, hash(owner), 'audit'), files = await readdir(directory)
    await writeFile(join(directory, files[0]), '{broken', { mode: 0o600 })
    await expect(vault.unlock(person)).rejects.toMatchObject({ code: 'AUDIT_FAILED' })
    expect(() => vault.clearAudit(stranger)).toThrow(VaultError)
    await vault.clearAudit(person); expect(vault.state().status).toBe('locked')
    await vault.unlock(person)
    expect((await vault.readAudit(person)).map(record => record.action)).toEqual(['clear', 'unlock'])
  })
  it('prunes the exact 90-day window and preserves new encrypted records', async () => {
    let time = 1_800_000_000_000
    const { vault } = await fixture({ now: () => time }); await setup(vault); await vault.appendAudit(event(), { effectPossible: false })
    time += RETENTION_MS + 1
    await vault.appendAudit(event(), { effectPossible: false })
    const records = await vault.readAudit(person)
    expect(records.length).toBe(1); expect(records[0].action).toBe('request')
  })
  it('rejects page/error/query payloads rather than persisting them in encrypted or generic logs', async () => {
    const { vault } = await fixture(); await setup(vault)
    for (const extra of [{ rawError: 'must-not-persist' }, { password: 'must-not-persist' }, { origin: 'https://example.test/?token=must-not-persist' }]) {
      const receipt = await vault.appendAudit({ ...event(), ...extra }, { effectPossible: false })
      expect(receipt.status).toBe('unavailable')
    }
    expect((await vault.readAudit(person)).every(record => record.action === 'setup')).toBe(true)
  })
  it.each([false, true])('fails closed with a safe receipt when an audit write fails; effectPossible=%s', async effectPossible => {
    const { vault, dependencies } = await fixture(); await setup(vault)
    const original = VaultDisk.prototype.write, secret = canaryInput().password
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/')) throw new Error(secret)
      return original.call(this, path, bytes)
    })
    const receipt = await vault.appendAudit(event(), { effectPossible })
    expect(receipt).toEqual({ status: effectPossible ? 'uncertain' : 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true })
    expect(JSON.stringify(receipt).includes(secret)).toBe(false)
    expect(vault.state().status).toBe('unavailable')
    expect(vi.mocked(dependencies.invalidate).mock.calls.at(-1)?.[0].reason).toBe('failure')
  })
  it('never reports saved success when audit fails before the credential write', async () => {
    const { vault, dependencies } = await fixture(); await setup(vault)
    const path = join(dependencies.root, hash(owner), 'vault.json'), before = await readFile(path), original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/')) throw new VaultError('STORAGE_FAILED')
      return original.call(this, path, bytes)
    })
    await expect(vault.save(person, randomUUID(), canaryInput())).rejects.toMatchObject({ code: 'AUDIT_FAILED' })
    expect(vault.state().status).toBe('unavailable')
    expect((await readFile(path)).equals(before)).toBe(false)
    vi.restoreAllMocks(); await vault.unlock(person)
    expect((await vault.list(person)).length).toBe(0)
  })
})
