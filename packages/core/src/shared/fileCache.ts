import type { FileSink } from './fileCipher'
import { requireFileRange } from './fileResolver'

/** Existing caches store bounded raw chunks. They never confer file access or carry encryption keys. */
export interface FileChunkCache {
  get(key: string, index: number): Promise<Uint8Array | null>
  put(key: string, index: number, bytes: Uint8Array): Promise<void>
  clear(key: string): Promise<void>
}

/** Browser private staging uses the existing cache, with an unguessable temporary namespace. */
export function createCachedFileSink(cache: FileChunkCache, size: number): FileSink {
  requireFileRange(size, 0, 0)
  const key = crypto.randomUUID().replaceAll('-', ''), entries: { offset: number; length: number }[] = []
  let written = 0, committed = false, disposed = false
  const dispose = async () => { if (!disposed) { disposed = true; await cache.clear(key) } }
  return {
    async write(bytes) {
      requireFileRange(size, written, bytes.length)
      if (committed || disposed) throw new Error('File staging is closed')
      await cache.put(key, entries.length, bytes)
      entries.push({ offset: written, length: bytes.length }); written += bytes.length
    },
    async commit() {
      if (committed || disposed || written !== size) throw new Error('Incomplete file staging')
      committed = true
      return { size, dispose, async read(offset, length) {
        requireFileRange(size, offset, length)
        if (disposed) throw new Error('File snapshot is disposed')
        const bytes = new Uint8Array(length)
        for (const [index, entry] of entries.entries()) {
          const start = Math.max(offset, entry.offset), end = Math.min(offset + length, entry.offset + entry.length)
          if (start >= end) continue
          const part = await cache.get(key, index)
          if (!part || part.length !== entry.length) throw new Error('File staging was removed or changed')
          bytes.set(part.subarray(start - entry.offset, end - entry.offset), start - offset)
        }
        return bytes
      } }
    }, abort: dispose,
  }
}
