import { useMemo } from 'react'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { AccountImRepository } from '../lib/imRepository'
import { chatService } from '../lib/chat'
import { decideColdStartFetch, deltaResultRequiresDegrade } from '../lib/coldStartFetch'
import { INITIAL_PAGE, NEWER_PAGE, maxMainlineSeq } from './chatMessageWindow'
import { seedCacheFromDisk } from './chatDiskWindow'
import { rendererLogger } from '../lib/log'
import { HistoryNotDownloadedError, readHistoryPage, retainHistoryPage } from '../lib/messageHistory'

import { ChatWindowCache } from './chatWindowCache'
import type { ChatHistoryWindow, FetchHistoryPage } from './chatHistoryWindow'

export function useChatWindowCache(accountId?: string | null) {
  const cache = useMemo(() => new ChatWindowCache(accountId), [accountId])
  return { cache, subscribeChatWindow: cache.subscribe }
}

export type WindowObserver = {
  current: () => boolean
  painted: (rows: MessageItem[], hasMoreOlder?: boolean) => void
  ready: (hasMoreOlder?: boolean) => void
  readSeqs: (seqs: Record<string, number>) => void
}

/** The main window's L1/L2, delta and result-side degrade path also opens topics and blocks. */
export async function openCachedChatWindow(options: {
  chatId: string; userId: string; cache: Map<string, MessageItem[]>; history: ChatHistoryWindow
  getRepository: () => Promise<AccountImRepository>
  expectedTailSeq: number | null; hasPositiveUnread: boolean
  observer: WindowObserver
  commit: (rows: MessageItem[], replaceTail: boolean, hasMoreOlder?: boolean) => void
  revalidate: () => Promise<void>
}): Promise<void> {
  const { chatId, userId, cache, observer } = options
  let painted = !!cache.get(chatId)?.some((message) => message.seq >= 0)
  if (!painted) {
    const repository = await options.getRepository()
    if (!observer.current()) return
    const disk = seedCacheFromDisk(cache, repository, chatId)
    if (disk) { observer.painted(disk.rows, disk.hasMoreOlder); painted = true }
  }
  if (!observer.current()) return
  if (painted && !navigator.onLine) { observer.ready(); return }
  const maxSeq = maxMainlineSeq(cache.get(chatId))
  const plan = decideColdStartFetch({
    hasCache: painted, maxSeq,
    expectedTailSeq: options.expectedTailSeq ?? maxSeq,
    // A topic visible to an observer may have no list row. Only a server delta proves its tail.
    hasPositiveUnread: options.hasPositiveUnread || options.expectedTailSeq === null,
  })
  const readSeqs = chatService.getOtherMembersReadSeqs(chatId, userId)
    .then((seqs) => { if (observer.current()) observer.readSeqs(seqs) })
    .catch((error: unknown) => rendererLogger('chat/window').error({ error, chatId }, 'member read seqs load failed'))
  const finalize = async (rows: MessageItem[], replaceTail: boolean, hasMoreOlder?: boolean) => {
    if (!observer.current()) return
    options.commit(rows, replaceTail, hasMoreOlder)
    observer.ready(hasMoreOlder)
    await Promise.all([options.revalidate(), readSeqs])
  }
  if (plan.kind === 'paintRevalidateOnly') {
    await finalize(cache.get(chatId) ?? [], false)
    return
  }
  if (plan.kind === 'paintLoadNewerDelta') {
    const rows = await chatService.getMessages(chatId, userId, 'loadNewer', NEWER_PAGE, undefined, plan.sinceSeq)
    if (!deltaResultRequiresDegrade(rows.length, NEWER_PAGE)) {
      await finalize(rows, false)
      return
    }
  }
  if (!painted) {
    await options.history.load('latest', fetchChatHistoryPage(userId, options.getRepository))
    const window = options.history.getSnapshot()
    await finalize(window.messages, true, window.hasOlder)
  } else {
    const rows = await chatService.getMessages(chatId, userId, 'initialLoad', INITIAL_PAGE)
    await finalize(rows, true, true)
  }
}

/** The existing history controller owns both primary and scoped pagination. */
export function fetchChatHistoryPage(userId: string, getRepository?: () => Promise<AccountImRepository>, preferRetained = false): FetchHistoryPage {
  return async (chatId, direction, cursor, limit) => {
    const repository = await getRepository?.()
    const query = { chatId, direction, cursor, limit }
    // This experiment covers room mainlines and topics; private conversations keep their existing reader.
    const retained = repository?.snapshot().chat.some((row) => row.id === chatId && isRoomChat(row.value.kind)) ? repository : undefined
    // Old anchors may paint a previously certified page online; their caller already
    // revalidates the resulting window. Latest/delta reads still require server authority.
    if (retained && (preferRetained || !navigator.onLine)) {
      const cached = await readHistoryPage(retained, query)
      if (cached !== null) return cached
      if (!navigator.onLine) throw new HistoryNotDownloadedError()
    }
    const rows = await (direction === 'newer' ? chatService.getMessages(chatId, userId, 'loadNewer', limit, undefined, cursor)
      : direction === 'older' ? chatService.getMessages(chatId, userId, 'loadOlder', limit, cursor)
        : chatService.getMessages(chatId, userId, 'initialLoad', limit))
    if (retained) await retainHistoryPage(retained, query, rows, rows.length)
    return rows
  }
}

export function restoreChatHistoryAnchor(window: ChatHistoryWindow, userId: string, messageId: string, getRepository?: () => Promise<AccountImRepository>): Promise<boolean> {
  return window.restoreAnchor(async (chatId) => {
    const repository = await getRepository?.()
    const local = await repository?.readMessage(messageId)
    if (!local && !navigator.onLine) throw new HistoryNotDownloadedError()
    const anchor = local?.value ?? await chatService.getMessageById(messageId, userId)
    if (!anchor || anchor.chat_id !== chatId || anchor.thread_root_id) throw new Error('Saved conversation message is no longer available')
    const fetch = fetchChatHistoryPage(userId, getRepository, true)
    const [older, newer] = await Promise.all([
      fetch(chatId, 'older', anchor.seq + 1, 20),
      fetch(chatId, 'newer', anchor.seq, 20),
    ])
    const messages = mergeMessagesById(older, newer, chatId)
    if (!messages.some((row) => row.id === messageId)) throw new Error('Saved conversation message is no longer visible')
    return { messages, hasNewer: newer.length === 20 }
  })
}
