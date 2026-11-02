import { openAsBlob, createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileSink } from '../../shared/fileCipher'
import { FILE_CHUNK_BYTES, requireFileRange, requireFileRevision } from '../../shared/fileResolver'
import type { FileChunkCache } from '../../shared/fileCache'
import { createHash, randomUUID } from 'node:crypto'
import { attachmentDownloadName } from '../../shared/attachmentDownloadName.mjs'
import { cloudFileProviders } from '../../cloud/fileProviders'
import { createFileResolver, openFileBytes, type FileProviders, type FileContext, type FileHandle } from '../../shared/fileResolver'
import type { AttachmentsEndpoint } from '../../cloud/attachmentsApi'
const cleanupRemoteFileDirectory = (directory: string) => rm(directory, { recursive: true, force: true })

/** Raw resumable chunks share the existing private open-file cache and its stale-directory cleanup. */
export function createFileChunkCache(tempRoot: string): FileChunkCache {
  const directory = (key: string, index = 0) => {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(key) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid file cache key')
    return join(tempRoot, `open-${key}`)
  }
  return {
    async get(key, index) {
      const file = join(directory(key, index), String(index)), info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!info) return null
      requireFileRange(FILE_CHUNK_BYTES, 0, info.size)
      return new Uint8Array(await readFile(file))
    },
    async put(key, index, bytes) {
      requireFileRange(FILE_CHUNK_BYTES, 0, bytes.length)
      const root = directory(key, index), file = join(root, String(index))
      await mkdir(root, { recursive: true, mode: 0o700 })
      const part = `${file}.${crypto.randomUUID()}.part`
      await writeFile(part, bytes, { flag: 'wx', mode: 0o600 }); await rename(part, file)
    },
    clear: key => cleanupRemoteFileDirectory(directory(key)),
  }
}

/** A private bounded staging file. Only a committed, read-only snapshot can leave this sink. */
export async function createFileSink(tempRoot: string, size: number, destination?: string): Promise<FileSink & { blob(): Promise<Blob>; path(): string }> {
  requireFileRange(size, 0, 0)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const directory = destination ? dirname(destination) : await mkdtemp(join(tempRoot, 'open-'))
  await chmod(directory, 0o700)
  const partial = destination ? `${destination}.${randomUUID()}.part` : join(directory, 'data.part'), path = destination ?? join(directory, 'data')
  let handle = await open(partial, 'wx', 0o600)
  let written = 0, committed = false, disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    try { await handle.close() } finally { if (destination) await rm(partial, { force: true }); else await cleanupRemoteFileDirectory(directory) }
  }
  return {
    async write(bytes) {
      if (committed || disposed || bytes.length > size - written) throw new Error('Invalid file staging write')
      await handle.writeFile(bytes)
      written += bytes.length
    },
    async commit() {
      if (committed || disposed || written !== size) throw new Error('Incomplete file snapshot')
      await handle.sync()
      await handle.close()
      await chmod(partial, destination ? 0o600 : 0o400)
      await rename(partial, path)
      handle = await open(path, 'r')
      committed = true
      return { size, dispose, async read(offset, length) {
        requireFileRange(size, offset, length)
        if (disposed) throw new Error('File snapshot is disposed')
        const bytes = new Uint8Array(length)
        let received = 0
        while (received < length) {
          const result = await handle.read(bytes, received, length - received, offset + received)
          if (!result.bytesRead) throw new Error('File snapshot was truncated')
          received += result.bytesRead
        }
        return bytes
      } }
    },
    abort: dispose,
    path() { if (!committed || disposed) throw new Error('File snapshot is not committed'); return path },
    async blob() {
      if (!committed || disposed) throw new Error('File snapshot is not committed')
      return openAsBlob(path)
    },
  }
}

/** All Node hosts configure the same resolver; desktop adds its existing local and held-SSH providers. */
export function createNodeFileResolver(root: string, endpoint: (context: FileContext) => Promise<AttachmentsEndpoint>) {
  const providers: FileProviders = { ...cloudFileProviders({ endpoint, cache: createFileChunkCache(root), sink: size => createFileSink(root, size) }), local: async () => null, ssh: async () => null }
  providers.saveTo = createFileSaver(providers)
  return createFileResolver(providers)
}

/** Downloads consume the authorized source into one final file. Random-read consumers keep snapshots. */
export function createFileSaver(providers: FileProviders): NonNullable<FileProviders['saveTo']> {
  return async (revision, context, directory, name) => {
    const path = join(directory, revision.sha256 ?? `legacy-${randomUUID()}`, attachmentDownloadName(name))
    const saved = { file_path: path, file_name: name, size_bytes: revision.size_bytes, sha256: revision.sha256!, content_type: revision.content_type }
    if (revision.sha256) {
      const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (existing?.isFile() && existing.size === revision.size_bytes) {
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(path)) { context.signal?.throwIfAborted(); hash.update(bytes) }
        context.signal?.throwIfAborted()
        if (hash.digest('hex') === revision.sha256) return saved
      }
    }
    const target = dirname(path)
    await mkdir(target, { recursive: true, mode: 0o700 })
    const sink = await createFileSink(target, revision.size_bytes, path)
    try {
      const bytes = await openFileBytes(providers, revision, { ...context, download: true }, undefined, sink)
      await bytes.dispose()
      if (!revision.sha256) {
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(path)) hash.update(bytes)
        saved.sha256 = hash.digest('hex')
      }
      return saved
    } catch (error) {
      await sink.abort()
      await rmdir(target).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure })
      throw error
    }
  }
}

/** Export only complete original bytes, with the existing portable filename and atomic replacement. */
export async function saveFileHandle(file: FileHandle, directory: string, name = file.revision.file_name) {
  if (file.saveTo) return file.saveTo(directory, name)
  return { ...await writeFileHandle(file, join(directory, file.revision.sha256 ?? `legacy-${randomUUID()}`, attachmentDownloadName(name))), file_name: name }
}

/** A trusted native save dialog may select an exact destination; the original still verifies before atomic rename. */
export async function writeFileHandle(file: FileHandle, path: string) {
  const target = dirname(path), partial = `${path}.${randomUUID()}.part`
  let output: Awaited<ReturnType<typeof open>> | undefined
  let createdDirectory: string | undefined
  const hash = createHash('sha256'); let size = 0
  try {
    requireFileRevision(file.revision)
    createdDirectory = await mkdir(target, { recursive: true, mode: 0o700 })
    output = await open(partial, 'wx', 0o600)
    for await (const chunk of file.stream()) { size += chunk.length; if (size > file.revision.size_bytes) throw new Error('File export size changed'); hash.update(chunk); await output.writeFile(chunk) }
    const observedSha = hash.digest('hex')
    if (size !== file.revision.size_bytes || file.revision.sha256 !== null && observedSha !== file.revision.sha256) throw new Error('File export SHA-256 mismatch')
    await output.sync(); await output.close(); await rename(partial, path)
    return { file_path: path, file_name: basename(path), size_bytes: size, sha256: observedSha, content_type: file.revision.content_type }
  } catch (error) {
    await output?.close().catch(() => undefined); await rm(partial, { force: true })
    if (createdDirectory === target) await rmdir(target).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure }); throw error
  }
  finally { await file.dispose() }
}
