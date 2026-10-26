import { fileRefKey, type FileContext, type FileRef } from '../shared/fileResolver'

export const FILE_METADATA_BATCH_MAX = 200
type Entry = { context: FileContext; waiters: { resolve(value: unknown): void; reject(error: unknown): void }[] }

/** Batch metadata, never permissions or bytes. Actor and cancellation scopes cannot borrow each other's results. */
export function createFileMetadataLoader(load: (context: FileContext, refs: FileRef[]) => Promise<unknown>) {
  let queues = new Map<AbortSignal | undefined, Map<string, Entry>>()
  async function flush() {
    const pending = queues; queues = new Map()
    for (const entries of pending.values()) {
      const actors = new Map<string, Entry[]>()
      for (const entry of entries.values()) {
        const key = JSON.stringify(entry.context.actor), group = actors.get(key) ?? []
        group.push(entry); actors.set(key, group)
      }
      for (const group of actors.values()) for (let i = 0; i < group.length; i += FILE_METADATA_BATCH_MAX) {
        const chunk = group.slice(i, i + FILE_METADATA_BATCH_MAX)
        try {
          chunk[0]!.context.signal?.throwIfAborted()
          const answer = await load(chunk[0]!.context, chunk.map(entry => entry.context.ref)) as { files?: { ref: FileRef }[] }
          if (!Array.isArray(answer?.files) || answer.files.length !== chunk.length) throw new Error('Invalid file metadata batch')
          const byRef = new Map(answer.files.map(row => [fileRefKey(row.ref), row]))
          if (byRef.size !== chunk.length || chunk.some(entry => !byRef.has(fileRefKey(entry.context.ref)))) throw new Error('File metadata references changed')
          for (const entry of chunk) {
            entry.context.signal?.throwIfAborted()
            for (const waiter of entry.waiters) waiter.resolve(byRef.get(fileRefKey(entry.context.ref)))
          }
        } catch (error) { for (const entry of chunk) for (const waiter of entry.waiters) waiter.reject(error) }
      }
    }
  }
  return (context: FileContext): Promise<unknown> => {
    context.signal?.throwIfAborted()
    const key = JSON.stringify([context.actor, fileRefKey(context.ref)])
    if (!queues.size) queueMicrotask(() => void flush())
    const queue = queues.get(context.signal) ?? new Map<string, Entry>()
    queues.set(context.signal, queue)
    const entry = queue.get(key) ?? { context, waiters: [] }
    queue.set(key, entry)
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }))
  }
}
