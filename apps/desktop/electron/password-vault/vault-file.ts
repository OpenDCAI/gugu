import { randomUUID } from 'node:crypto'
import { VaultError, type VaultDependencies } from './contracts'
import { decode, openedJson, sealedJson, serialize, unseal } from './crypto'
import { VaultDisk } from './disk'
import { binding, documentSchema, hash, installationSchema, parse, payloadSchema, type Installation, type VaultDocument, type VaultPayload } from './schema'

export function readJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown }
  catch { throw new VaultError('DATA_DAMAGED') }
  finally { bytes.fill(0) }
}
export class VaultFile {
  readonly owner: string
  readonly disk: VaultDisk
  constructor(private readonly dependencies: VaultDependencies) {
    this.owner = hash(dependencies.accountId)
    this.disk = new VaultDisk(dependencies.root, dependencies.assertPrivateStorageReady)
  }
  private get path(): string { return `${this.owner}/vault.json` }
  async installation(create = false): Promise<Installation> {
    const bytes = await this.disk.read('installation.json')
    if (bytes) {
      const value = parse(installationSchema, readJson(bytes))
      if (value.binding !== hash(this.dependencies.installationBinding)) throw new VaultError('WRONG_INSTALLATION')
      return value
    }
    if (!create) throw new VaultError('NOT_INITIALIZED')
    if ((await this.disk.list('.')).length !== 0) throw new VaultError('DATA_DAMAGED')
    const value: Installation = { schema: 1, id: randomUUID(), binding: hash(this.dependencies.installationBinding), owners: [] }
    await this.disk.write('installation.json', serialize(value))
    return value
  }
  async assertEmpty(): Promise<Installation> {
    const installation = await this.installation(true)
    const bytes = await this.disk.read(this.path)
    if (bytes) { bytes.fill(0); throw new VaultError('ALREADY_EXISTS') }
    if (installation.owners.includes(this.owner)) throw new VaultError('DATA_MISSING')
    return installation
  }
  async load(): Promise<VaultDocument> {
    const installation = await this.installation()
    const bytes = await this.disk.read(this.path)
    if (!bytes) throw new VaultError(installation.owners.includes(this.owner) ? 'DATA_MISSING' : 'NOT_INITIALIZED')
    const document = parse(documentSchema, readJson(bytes))
    if (!installation.owners.includes(this.owner)) throw new VaultError('DATA_DAMAGED')
    if (document.owner !== this.owner) throw new VaultError('WRONG_ACCOUNT')
    if (document.installationId !== installation.id) throw new VaultError('WRONG_INSTALLATION')
    return document
  }
  payload(document: VaultDocument, key: Buffer): VaultPayload {
    return parse(payloadSchema, openedJson(key, document.payload, binding(document, 'data')))
  }
  async create(document: VaultDocument): Promise<void> {
    const installation = await this.assertEmpty()
    // Record existence first. Partial setup must become DATA_MISSING, never silently an empty vault.
    await this.disk.write('installation.json', serialize({ ...installation, owners: [...installation.owners, this.owner] }))
    await this.persist(document)
  }
  async persist(document: VaultDocument): Promise<void> { await this.disk.write(this.path, serialize(document)) }
  async make(key: Buffer, recovery: Buffer, vaultId: string, payload: VaultPayload): Promise<VaultDocument> {
    const installation = await this.installation(true)
    const document: VaultDocument = { schema: 1, owner: this.owner, installationId: installation.id, vaultId,
      localKey: '', recoveryKey: { nonce: '', tag: '', ciphertext: '' }, payload: { nonce: '', tag: '', ciphertext: '' } }
    document.localKey = await this.dependencies.keys.wrap(key, binding(document, 'local'))
    document.recoveryKey = sealedJson(recovery, { key: key.toString('base64') }, binding(document, 'recovery'))
    document.payload = sealedJson(key, payload, binding(document, 'data'))
    return document
  }
  recover(document: VaultDocument, material: string): Buffer {
    const match = /^gugu-vault-v1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(material)
    if (!match || match[1] !== document.vaultId) throw new VaultError('RECOVERY_INVALID')
    const recovery = Buffer.from(match[2], 'base64url')
    let plain: Buffer | undefined
    try {
      plain = unseal(recovery, document.recoveryKey, binding(document, 'recovery'))
      const value = readJson(Buffer.from(plain)) as { key?: unknown }
      if (!value || typeof value.key !== 'string') throw new VaultError('RECOVERY_INVALID')
      const key = decode(value.key)
      if (key.length !== 32) { key.fill(0); throw new VaultError('RECOVERY_INVALID') }
      return key
    } catch { throw new VaultError('RECOVERY_INVALID') }
    finally { recovery.fill(0); plain?.fill(0) }
  }
}
