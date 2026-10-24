import { openAsBlob } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSink } from '@gugu/core/shared/fileCipher'
import { requireFileRange } from '@gugu/core/shared/fileResolver'
import { cleanupRemoteFileDirectory } from './remoteFileOpen'

/** A private bounded staging file. Only a committed, read-only snapshot can leave this sink. */
export async function createFileSink(tempRoot: string, size: number): Promise<FileSink & { blob(): Promise<Blob> }> {
  requireFileRange(size, 0, 0)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(tempRoot, 'open-'))
  await chmod(directory, 0o700)
  const partial = join(directory, 'data.part'), path = join(directory, 'data')
  let handle = await open(partial, 'wx', 0o600)
  let written = 0, committed = false, disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    try { await handle.close() } finally { await cleanupRemoteFileDirectory(directory) }
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
      await chmod(partial, 0o400)
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
    async blob() {
      if (!committed || disposed) throw new Error('File snapshot is not committed')
      return openAsBlob(path)
    },
  }
}
