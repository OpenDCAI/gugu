import { z } from 'zod'
import type { AuditInput, AuditRecord } from './contracts'
import { VaultError } from './contracts'
import { openedJson, sealedJson, serialize } from './crypto'
import { auditInput, binding, parse, recordSchema, RETENTION_MS, type VaultDocument } from './schema'
import type { VaultDisk } from './disk'

const auditFile = /^(\d{13})-([a-f0-9-]{36})\.audit$/
const envelope = z.strictObject({ nonce: z.string(), tag: z.string(), ciphertext: z.string() })
/** No key cache or second unlock state: callers pass the live vault key for each operation. */
export class EncryptedVaultAudit {
  constructor(private readonly disk: VaultDisk, private readonly owner: string, private readonly now: () => number) {}
  prepare(document: VaultDocument, key: Buffer, accountId: string, input: AuditInput): { id: string; path: string; bytes: Buffer } {
    const time = this.now()
    const record: AuditRecord = { ...auditInput(input), id: input.id, at: new Date(time).toISOString(), accountId }
    const parsed = parse(recordSchema, record)
    const path = `${this.owner}/audit/${String(time).padStart(13, '0')}-${record.id}.audit`
    return { id: record.id, path, bytes: serialize(sealedJson(key, parsed, binding(document, 'data') + ':audit:' + record.id)) }
  }
  async existing(document: VaultDocument, key: Buffer, accountId: string, input: AuditInput): Promise<string | undefined> {
    const found = (await this.read(document, key, accountId)).filter(record => record.id === input.id)
    if (found.length > 1) throw new VaultError('AUDIT_FAILED')
    if (!found.length) return undefined
    const { at: _at, accountId: _owner, ...previous } = found[0]
    if (JSON.stringify(auditInput(previous)) !== JSON.stringify(auditInput(input))) throw new VaultError('INVALID_INPUT')
    return found[0].id
  }
  async persist(prepared: ReturnType<EncryptedVaultAudit['prepare']>): Promise<void> {
    try { await this.prune(); await this.disk.write(prepared.path, prepared.bytes) }
    finally { prepared.bytes.fill(0) }
  }
  private async files(): Promise<string[]> {
    const files = await this.disk.list(`${this.owner}/audit`)
    // A crashed atomic write can leave ciphertext-only .tmp files. Never treat these as records.
    if (files.some(file => !auditFile.test(file) && !/\.tmp$/.test(file))) throw new VaultError('AUDIT_FAILED')
    return files.filter(file => auditFile.test(file)).sort()
  }
  async prune(): Promise<void> {
    for (const file of await this.files()) if (Number(auditFile.exec(file)![1]) < this.now() - RETENTION_MS) await this.disk.remove(`${this.owner}/audit/${file}`)
  }
  async read(document: VaultDocument, key: Buffer, accountId: string): Promise<AuditRecord[]> {
    await this.prune()
    const records: AuditRecord[] = []
    for (const file of await this.files()) {
      const [, timestamp, id] = auditFile.exec(file)!
      const bytes = await this.disk.read(`${this.owner}/audit/${file}`)
      if (!bytes) throw new VaultError('AUDIT_FAILED')
      try {
        const sealed = parse(envelope, JSON.parse(bytes.toString('utf8')) as unknown)
        const record = parse(recordSchema, openedJson(key, sealed, binding(document, 'data') + ':audit:' + id))
        if (record.accountId !== accountId || record.id !== id || Date.parse(record.at) !== Number(timestamp)) throw new VaultError('AUDIT_FAILED')
        if (Date.parse(record.at) >= this.now() - RETENTION_MS) records.push(record)
      } finally { bytes.fill(0) }
    }
    return records
  }
  async clear(): Promise<void> {
    // Validate every entry before the first removal. Clearing cannot imply secure erase of filesystem backups.
    const files = await this.files()
    for (const file of files) { const bytes = await this.disk.read(`${this.owner}/audit/${file}`); bytes?.fill(0) }
    for (const file of files) await this.disk.remove(`${this.owner}/audit/${file}`)
  }
}
