import { validatePage, type AccountRevisionPage, type AccountRevisionSource } from './accountRevisionRuntime'
import { ingestMessages, localMessageQueries } from './messageIngest'
import { messageRevisionWrites } from './messageRevisionWrites'
import { initializeMessageWindows, messageWindow } from './messageWindows'

/** Align before publishing any cached window. First upgrade deliberately starts empty at S. */
export async function alignMessageStore(accountId: string, target: string,
  source: Pick<AccountRevisionSource, 'syncSince'>, signal: AbortSignal): Promise<void> {
  if (messageWindow(accountId, '') === null) return
  const initial = await localMessageQueries()!.throughRevision(accountId)
  const baseline = () => ingestMessages(accountId, { writes: [], revisions: [], throughRevision: target })
  if (initial === null) { await baseline(); return }
  let cursor = initial
  while (BigInt(cursor) < BigInt(target)) {
    signal.throwIfAborted()
    const page: AccountRevisionPage | null = await source.syncSince(cursor, 100, signal).catch(async (error: unknown) => {
      const message = error && typeof error === 'object' && 'message' in error ? error.message : null
      if (typeof message !== 'string' || !/^revision gap after \d+, first available (?:\d+|<NULL>)$/.test(message)) throw error
      await ingestMessages(accountId, 'clear')
      initializeMessageWindows(accountId)
      await baseline()
      return null
    })
    if (!page) return
    signal.throwIfAborted()
    validatePage(page, cursor)
    const operations = page.operations.filter(operation => BigInt(operation.revision) <= BigInt(target))
    if (!operations.length) throw new Error('Message replay ended before the snapshot revision')
    cursor = operations[operations.length - 1]!.revision
    await ingestMessages(accountId, messageRevisionWrites(accountId, operations, cursor))
  }
}
