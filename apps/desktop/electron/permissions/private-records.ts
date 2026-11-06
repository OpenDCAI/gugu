import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PermissionCaller } from './operation'
import type { PermissionDecision, PermissionOperation } from './rules'

export interface PersonPrincipal { kind: 'person' | 'agent'; userId: string }
export function requirePermissionOwner(principal: PersonPrincipal, ownerId: string): void {
  if (principal.kind !== 'person' || principal.userId !== ownerId) throw new Error('Only the owning person may administer service permissions')
}
export interface PrivatePermissionRecord {
  id: string
  at: string
  phase: 'before' | 'after' | 'administration'
  mode: 'observe' | 'enforce'
  agent: string
  session: string
  tool: string
  target: string
  decision: PermissionDecision
  outcome: 'would_allow' | 'would_ask' | 'would_deny' | 'blocked' | 'completed' | 'failed' | 'unknown' | 'enabled' | 'disabled'
}
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const noFile = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const dayFile = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/** Bind validation and I/O to one open file; a hard-linked private file is compromised, even for the owner API. */
async function openPrivateFile(path: string, flags = constants.O_RDONLY) {
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('Private permission file must be regular with a single link')
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function readPrivateFile(path: string): Promise<string> {
  const handle = await openPrivateFile(path)
  try { return await handle.readFile('utf8') } finally { await handle.close() }
}
async function verifyPrivateFile(path: string): Promise<void> {
  const handle = await openPrivateFile(path)
  await handle.close()
}

/** Local and person-only. No chat, timeline, upload, resource-index or MCP reader is registered for these files. */
export class PrivatePermissionRecords {
  constructor(private readonly root: string, private readonly now = () => new Date()) {}
  private directory(ownerId: string): string { return join(this.root, createHash('sha256').update(ownerId).digest('hex')) }
  private async prepare(ownerId: string): Promise<string> {
    const directory = this.directory(ownerId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    return directory
  }
  async enforcement(ownerId: string): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readPrivateFile(join(this.directory(ownerId), 'enforcement.json')))
      if (!value || typeof value !== 'object' || typeof (value as { enabled?: unknown }).enabled !== 'boolean') throw new Error('Malformed permission enforcement setting')
      return (value as { enabled: boolean }).enabled
    } catch (error) { if (noFile(error)) return false; throw error }
  }
  /** The future trusted person IPC calls this; neither a tool argument nor an Agent's bearer reaches it. */
  async setEnforcement(principal: PersonPrincipal, ownerId: string, enabled: boolean): Promise<void> {
    requirePermissionOwner(principal, ownerId)
    if (typeof enabled !== 'boolean') throw new Error('Invalid enforcement setting')
    const directory = await this.prepare(ownerId)
    const target = join(directory, 'enforcement.json')
    await verifyPrivateFile(target).catch(error => { if (!noFile(error)) throw error })
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify({ enabled }), { mode: 0o600, flag: 'wx' })
      await verifyPrivateFile(temporary)
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(error => { if (!noFile(error)) throw error }) }
  }
  private async salt(ownerId: string): Promise<Buffer> {
    const directory = await this.prepare(ownerId)
    const path = join(directory, 'target-key')
    try { return await readFile(path).then(key => { if (key.length !== 32) throw new Error('Invalid permission record key'); return key }) }
    catch (error) { if (!noFile(error)) throw error }
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
      // Publish complete bytes atomically; another first caller must never read a half-written key.
      try { await link(temporary, path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { await unlink(temporary).catch(error => { if (!noFile(error)) throw error }) }
    const key = await readFile(path)
    if (key.length !== 32) throw new Error('Invalid permission record key')
    return key
  }
  async append(caller: PermissionCaller, operation: PermissionOperation, entry: Pick<PrivatePermissionRecord, 'id' | 'phase' | 'mode' | 'decision' | 'outcome'>): Promise<void> {
    const directory = await this.prepare(caller.ownerId)
    const key = await this.salt(caller.ownerId)
    const pseudonym = (value: string) => createHmac('sha256', key).update(value).digest('hex')
    const record: PrivatePermissionRecord = {
      ...entry, at: this.now().toISOString(), agent: caller.subjectId, session: caller.sessionId,
      tool: operation.classified ? operation.tool : `dynamic:${pseudonym(operation.namespace + '/' + operation.tool)}`,
      target: pseudonym(JSON.stringify(operation.resource)),
    }
    const path = join(directory, `${record.at.slice(0, 10)}.jsonl`)
    // Refuse an unbounded daily file, including in enforced mode before a side effect can start.
    const handle = await openPrivateFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT)
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('Permission record daily capacity reached')
      await handle.appendFile(`${JSON.stringify(record)}\n`)
      await handle.chmod(0o600)
    } finally { await handle.close() }
    await this.prune(caller.ownerId)
  }
  private async files(ownerId: string): Promise<string[]> {
    try { return (await readdir(this.directory(ownerId))).filter(name => dayFile.test(name)).sort() }
    catch (error) { if (noFile(error)) return []; throw error }
  }
  private async prune(ownerId: string): Promise<void> {
    const cutoffDay = new Date(this.now().getTime() - RETENTION_MS).toISOString().slice(0, 10)
    for (const file of await this.files(ownerId)) if (file.slice(0, 10) < cutoffDay) {
      await verifyPrivateFile(join(this.directory(ownerId), file)).catch(error => { if (!noFile(error)) throw error })
      await unlink(join(this.directory(ownerId), file)).catch(error => { if (!noFile(error)) throw error })
    }
  }
  async read(principal: PersonPrincipal, ownerId: string, limit = 100): Promise<PrivatePermissionRecord[]> {
    requirePermissionOwner(principal, ownerId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid permission record limit')
    await this.prune(ownerId)
    const records: PrivatePermissionRecord[] = []
    for (const file of (await this.files(ownerId)).reverse()) {
      const lines = (await readPrivateFile(join(this.directory(ownerId), file))).trim().split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        const record = JSON.parse(line) as PrivatePermissionRecord
        if (Date.parse(record.at) >= this.now().getTime() - RETENTION_MS) records.push(record)
        if (records.length === limit) return records
      }
    }
    return records
  }
  async clear(principal: PersonPrincipal, ownerId: string): Promise<void> {
    requirePermissionOwner(principal, ownerId)
    const files = await this.files(ownerId)
    for (const file of files) await verifyPrivateFile(join(this.directory(ownerId), file))
    for (const file of files) await unlink(join(this.directory(ownerId), file))
  }
}
