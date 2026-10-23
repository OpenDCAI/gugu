import { useMemo } from 'react'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { AccountImRepository } from '../lib/imRepository'
import { chatService } from '../lib/chat'
import { decideColdStartFetch, deltaResultRequiresDegrade } from '../lib/coldStartFetch'
import { INITIAL_PAGE, NEWER_PAGE, maxMainlineSeq } from './chatMessageWindow'
import { seedCacheFromDisk } from './chatDiskWindow'
import { rendererLogger } from '../lib/log'

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
    await options.history.load('latest', fetchChatHistoryPage(userId))
    const window = options.history.getSnapshot()
    await finalize(window.messages, false, window.hasOlder)
  } else {
    const rows = await chatService.getMessages(chatId, userId, 'initialLoad', INITIAL_PAGE)
    await finalize(rows, true, true)
  }
}

/** The existing history controller owns both primary and scoped pagination. */
export function fetchChatHistoryPage(userId: string): FetchHistoryPage {
  return (chatId, way, cursor, limit) => way === 'newer'
    ? chatService.getMessages(chatId, userId, 'loadNewer', limit, undefined, cursor)
    : way === 'older' ? chatService.getMessages(chatId, userId, 'loadOlder', limit, cursor)
      : chatService.getMessages(chatId, userId, 'initialLoad', limit)
}

export function restoreChatHistoryAnchor(window: ChatHistoryWindow, userId: string, messageId: string): Promise<boolean> {
  return window.restoreAnchor(async (chatId) => {
    const anchor = await chatService.getMessageById(messageId, userId)
    if (!anchor || anchor.chat_id !== chatId || anchor.thread_root_id) throw new Error('Saved conversation message is no longer available')
    const [older, newer] = await Promise.all([
      chatService.getMessages(chatId, userId, 'loadOlder', 20, anchor.seq + 1),
      chatService.getMessages(chatId, userId, 'loadNewer', 20, undefined, anchor.seq),
    ])
    const messages = mergeMessagesById(older, newer, chatId)
    if (!messages.some((row) => row.id === messageId)) throw new Error('Saved conversation message is no longer visible')
    return { messages, hasNewer: newer.length === 20 }
  })
}
