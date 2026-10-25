import { readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const REMOTE_FILE_TTL_MS = 60 * 60 * 1000

export function sanitizeRemoteFileName(value: string): string {
  const leaf = [...basename(value.replaceAll('\\', '/'))]
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
  if (!leaf || leaf === '.' || leaf === '..') return 'attachment'
  if (leaf.length <= 200) return leaf
  const extension = extname(leaf)
  if (extension.length >= 200) throw new Error('Remote file extension exceeds the filename limit')
  return `${leaf.slice(0, 200 - extension.length)}${extension}`
}

export async function cleanupRemoteFileDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

/** Keep the existing one-hour native-open cache lifetime, including failed OS opens. */
export function trackRemoteFileDirectory(directories: Set<string>, directory: string): void {
  if (directories.has(directory)) return
  directories.add(directory)
  const timer = setTimeout(() => { directories.delete(directory); void cleanupRemoteFileDirectory(directory) }, REMOTE_FILE_TTL_MS)
  timer.unref()
}

export async function cleanupStaleRemoteFileDirectories(
  tempRoot: string,
  now = Date.now(),
  ttlMs = REMOTE_FILE_TTL_MS,
): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('open-'))
    .map(async (entry) => {
      const directory = join(tempRoot, entry.name)
      const metadata = await stat(directory)
      if (now - metadata.mtimeMs >= ttlMs) await cleanupRemoteFileDirectory(directory)
    }))
}
