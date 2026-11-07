import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VaultError } from './contracts'

const MAX_BYTES = 32 * 1024 * 1024
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
/** One Electron-main writer. All temporary bytes are already ciphertext under the registered root. */
export class VaultDisk {
  constructor(readonly root: string, private readonly ready: () => Promise<void>) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new VaultError('INVALID_INPUT')
  }
  private path(relative: string): string {
    const path = resolve(this.root, relative)
    if (!path.startsWith(this.root + '/')) throw new VaultError('INVALID_INPUT')
    return path
  }
  private async directory(path: string, create: boolean): Promise<void> {
    let cursor = parsePath(path).root
    for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
      cursor = join(cursor, part)
      let info
      try { info = await lstat(cursor) }
      catch (error) {
        if (!create || !absent(error)) throw error
        try { await mkdir(cursor, { mode: 0o700 }) } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure }
        info = await lstat(cursor)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VaultError('STORAGE_FAILED')
      if (cursor === this.root || cursor.startsWith(this.root + '/')) {
        if ((info.mode & 0o077) !== 0) throw new VaultError('STORAGE_FAILED')
      }
    }
  }
  async read(relative: string): Promise<Buffer | null> {
    await this.ready()
    const path = this.path(relative)
    try {
      await this.directory(dirname(path), false)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) throw new VaultError('STORAGE_FAILED')
        const bytes = await handle.readFile()
        if (bytes.length > MAX_BYTES) throw new VaultError('STORAGE_FAILED')
        return bytes
      } finally { await handle.close() }
    } catch (error) { if (absent(error)) return null; throw new VaultError('STORAGE_FAILED') }
  }
  async list(relative: string): Promise<string[]> {
    await this.ready()
    const path = relative === '.' ? this.root : this.path(relative)
    try { await this.directory(path, false); return await readdir(path) }
    catch (error) { if (absent(error)) return []; throw new VaultError('STORAGE_FAILED') }
  }
  async write(relative: string, bytes: Buffer): Promise<void> {
    await this.ready()
    if (bytes.length > MAX_BYTES) throw new VaultError('STORAGE_FAILED')
    const path = this.path(relative), temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await this.directory(dirname(path), true)
      // Refuse an existing alias before replacing it. The boundary remains the independent Agent exclusion.
      const existing = await this.read(relative)
      existing?.fill(0)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await this.ready()
      await this.directory(dirname(path), false)
      await rename(temporary, path)
      const directory = await open(dirname(path), constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch { throw new VaultError('STORAGE_FAILED') }
    finally { await unlink(temporary).catch(error => { if (!absent(error)) throw new VaultError('STORAGE_FAILED') }) }
  }
  async remove(relative: string): Promise<void> {
    await this.ready()
    const bytes = await this.read(relative)
    if (!bytes) return
    bytes.fill(0)
    try {
      await unlink(this.path(relative))
      const directory = await open(dirname(this.path(relative)), constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch { throw new VaultError('STORAGE_FAILED') }
  }
}
