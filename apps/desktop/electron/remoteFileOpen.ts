import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const REMOTE_FILE_LIMIT_BYTES = 100 * 1024 * 1024
export const REMOTE_FILE_TTL_MS = 60 * 60 * 1000

// 「用系统应用打开」一个聊天附件(附件进群文件夹 ③):字节由渲染层给(它从 Cache Storage 或签名链接取到的那一份,
// lib/attachmentBytes),主进程不再按 URL 去下 —— 新附件的链接是 CDN 签名链接,主进程既不知道该信哪个域名,也没有必要再下一遍。
// 落盘按内容的 sha256 分目录:同一份字节打开几次都是同一个文件(系统应用还开着它也不重写);写到临时名再改名,
// 别的打开永远看不到写了一半的文件。
export interface OpenBytesDependencies {
  tempRoot: string
  openPath: (path: string) => Promise<string>
  maxBytes?: number
}

export interface OpenedRemoteFile {
  directory: string
  path: string
}

export async function openBytesInSystemApp(
  input: { bytes: Uint8Array; filename: string },
  dependencies: OpenBytesDependencies,
): Promise<OpenedRemoteFile> {
  const maxBytes = dependencies.maxBytes ?? REMOTE_FILE_LIMIT_BYTES
  if (input.bytes.byteLength > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte limit`)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const directory = join(dependencies.tempRoot, `open-${sha256}`)
  const path = join(directory, sanitizeRemoteFileName(input.filename))
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing?.size !== input.bytes.byteLength) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const partial = `${path}.${randomUUID()}.part`
    try {
      await writeFile(partial, input.bytes, { flag: 'wx', mode: 0o600 })
      await rename(partial, path)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
  }
  // 打不开不删字节:同一份可能正被另一次打开用着,下一次打开照样用它。
  const openError = await dependencies.openPath(path)
  if (openError) throw new Error(`Could not open file: ${openError}`)
  return { directory, path }
}

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
