import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Recovery belongs to the controlling installation, outside the retired assistant's workspace. */
export function createMoveJournalFileStore(root: string) {
  const pathFor = (owner: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid move journal owner')
    return join(root, `${owner}.json`)
  }
  const read = async (owner: string): Promise<string | null> => {
    try { return await readFile(pathFor(owner), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return {
    read,
    async write(owner: string, value: string) {
      const path = pathFor(owner)
      if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) throw new Error('Invalid move journal')
      JSON.parse(value)
      await mkdir(root, { recursive: true })
      const temp = `${path}.${crypto.randomUUID()}.tmp`
      try {
        const file = await open(temp, 'wx', 0o600)
        try { await file.writeFile(value, 'utf8'); await file.sync() }
        finally { await file.close() }
        await rename(temp, path)
        if (await read(owner) !== value) throw new Error('Move journal verification failed')
      } finally { await rm(temp, { force: true }) }
    },
    async clear(owner: string) { await rm(pathFor(owner), { force: true }) },
  }
}
