import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageStore, ImMessageBatch, ImMessagePage, ImMessagePageResult } from '../session/shared/core/im-messages'
import type { imMessagesController } from '../../electron/session/main/core/im-messages/controller'
import { createRPCClient } from '../session/shared/lib/ipc/rpc'
import { desktopIpc } from '../platform/desktopIpc'
import { platform } from '../platform'
import type { LocalImDbAdapter } from './localSyncDb'
import { acceptMessageWrites, clearMessageWindows, initializeMessageWindows, messageWindow, setMessageWindow } from './messageWindows'
import { MAX_WINDOW } from '../store/chatMessageWindow'
const commits = new Map<string, Promise<unknown>>()

function store(): MessageStore {
  const bridge = desktopIpc()
  if (!bridge) throw new Error('Local message storage is unavailable')
  return createRPCClient<{ imMessages: typeof imMessagesController }>(bridge.invoke).imMessages
}

/** Read-only access cannot acquire either renderer write method. */
export function localMessageQueries(): Omit<MessageStore, 'ingest' | 'clearAccount'> | null {
  if (!desktopIpc()) return null
  const { windows, page, search, throughRevision } = store()
  return { windows, page, search, throughRevision }
}

/** Phase two removes this platform seam when the phone uses the same SQLite store. */
export async function initializeMessages(accountId: string, adapter: LocalImDbAdapter): Promise<void> {
  if (platform.localMessages !== 'sqlite') return
  if (!adapter.prepareLocalMessages) throw new Error('Local message cache migration is unavailable')
  await adapter.prepareLocalMessages(accountId)
  initializeMessageWindows(accountId)
}

/** All renderer writes to the local store, including clears, enter here. */
export async function ingestMessages(accountId: string, batch: ImMessageBatch | 'clear' | (() => ImMessageBatch)) {
  // Phase two removes this seam; phone writes remain in the existing window path for now.
  if (platform.localMessages !== 'sqlite') return null
  if (batch !== 'clear' && messageWindow(accountId, '') === null) throw new DOMException('Local message account is closed', 'AbortError')
  // Defer parsing as well: the phone keeps its existing revision consumers unchanged.
  const resolved = typeof batch === 'function' ? batch() : batch
  const commit = () => commitMessages(accountId, resolved)
  const run = (commits.get(accountId) ?? Promise.resolve()).then(commit, commit)
  commits.set(accountId, run)
  const settle = () => { if (commits.get(accountId) === run) commits.delete(accountId) }
  void run.then(settle, settle)
  return run
}

async function commitMessages(accountId: string, batch: ImMessageBatch | 'clear') {
  const imMessages = store()
  if (batch === 'clear') {
    await imMessages.clearAccount(accountId)
    clearMessageWindows(accountId)
    return []
  }
  // A page arriving after explicit logout must not recreate the just-cleared local history.
  if (messageWindow(accountId, '') === null) throw new DOMException('Local message account is closed', 'AbortError')
  const accepted = await imMessages.ingest(accountId, batch)
  const reads = acceptMessageWrites(accountId, accepted)
  await publishWindows(accountId, reads.filter(read => !read.root).map(read => read.chatId))
  for (const { chatId, root } of reads) if (root) {
    const page = await imMessages.page(accountId, { chatId, threadRootId: root, limit: MAX_WINDOW })
    setMessageWindow(accountId, chatId, root, page.rows)
  }
  return accepted
}

async function publishWindows(accountId: string, chatIds: string[]): Promise<void> {
  if (!chatIds.length) return
  const rows = await store().windows(accountId, chatIds, MAX_WINDOW)
  for (const chatId of chatIds) setMessageWindow(accountId, chatId, null, rows.filter(row => row.chat_id === chatId))
}

export async function prefetchMessages(accountId: string, chatIds: string[]): Promise<void> {
  if (messageWindow(accountId, '') !== null) await publishWindows(accountId, chatIds)
}

export async function readMessagePage(accountId: string, page: ImMessagePage): Promise<ImMessagePageResult | null> {
  // Initialization owns the platform choice. Phone windows are deliberately not a second MessageStore.
  const bridge = desktopIpc()
  return bridge ? store().page(accountId, page) : null
}

export async function ingestMessagePage(accountId: string, rows: MessageItem[], chatId: string,
  limit: number, beforeSeq?: number, afterSeq?: number, threadRootId: string | null = null, rawCount = rows.length): Promise<void> {
  const fromSeq = afterSeq !== undefined ? afterSeq + 1 : rawCount < limit ? 1 : rows[0]?.seq
  const toSeq = beforeSeq !== undefined ? beforeSeq - 1 : rows[rows.length - 1]?.seq
  await ingestMessages(accountId, { writes: rows.map(message => ({ type: 'put', message })), revisions: [],
    ranges: fromSeq !== undefined && toSeq !== undefined && fromSeq <= toSeq
      ? [{ chatId, threadRootId, fromSeq, toSeq }] : [] })
}
