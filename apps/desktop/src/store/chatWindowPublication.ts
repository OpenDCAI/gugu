import { useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { AccountImRepository } from '../lib/imRepository'
import { chatService } from '../lib/chat'
import { decideColdStartFetch, deltaResultRequiresDegrade } from '../lib/coldStartFetch'
import { INITIAL_PAGE, NEWER_PAGE, maxMainlineSeq } from './chatMessageWindow'
import { seedCacheFromDisk } from './chatDiskWindow'

type Listener = (rows: MessageItem[]) => void

/** The existing message cache owns publication; every mutation reaches its visible surfaces. */
export class ChatWindowCache extends Map<string, MessageItem[]> {
  private readonly listeners = new Map<string, Set<Listener>>()
  override set(chatId: string, rows: MessageItem[]): this {
    super.set(chatId, rows)
    this.publish(chatId, rows)
    return this
  }
  override delete(chatId: string): boolean {
    const deleted = super.delete(chatId)
    if (deleted) this.publish(chatId, [])
    return deleted
  }
  override clear(): void {
    const ids = [...this.keys()]
    super.clear()
    for (const id of ids) this.publish(id, [])
  }
  private publish(chatId: string, rows: MessageItem[]): void {
    for (const listener of this.listeners.get(chatId) ?? []) listener(rows)
  }
  readonly subscribe = (chatId: string, listener: Listener): (() => void) => {
    let listeners = this.listeners.get(chatId)
    if (!listeners) this.listeners.set(chatId, listeners = new Set())
    listeners.add(listener)
    listener(this.get(chatId) ?? [])
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(chatId)
    }
  }
}

export function useChatWindowCache() {
  const [cache] = useState(() => new ChatWindowCache())
  return { cache, subscribeChatWindow: cache.subscribe }
}

export type WindowObserver = {
  current: () => boolean
  painted: (rows: MessageItem[], hasMoreOlder?: boolean) => void
  ready: (hasMoreOlder?: boolean) => void
  readSeqs: (seqs: Record<string, number>) => void
}

/** Operations on the account's existing window, independent of the primary view selection. */
export type ChatWindowAccess = {
  read: (chatId: string) => MessageItem[] | undefined
  write: (chatId: string, updater: (rows: MessageItem[]) => MessageItem[]) => void
  persist: (chatId: string, rows: MessageItem[]) => void
  open: (chatId: string, observer: WindowObserver) => Promise<void>
  heal: (chatId: string, throwOnError: boolean, readSeqs?: WindowObserver['readSeqs']) => Promise<void>
  revalidate: (chatId: string, throwOnError?: boolean) => Promise<void>
}

/** The main window's L1/L2, delta and result-side degrade path also opens topics and blocks. */
export async function openCachedChatWindow(options: {
  chatId: string; userId: string; cache: Map<string, MessageItem[]>
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
  const finalize = async (rows: MessageItem[], seqs: Record<string, number>, replaceTail: boolean, hasMoreOlder?: boolean) => {
    if (!observer.current()) return
    options.commit(rows, replaceTail, hasMoreOlder)
    observer.readSeqs(seqs)
    observer.ready(hasMoreOlder)
  }
  if (plan.kind === 'paintRevalidateOnly') {
    const seqs = await chatService.getOtherMembersReadSeqs(chatId, userId)
    await finalize(cache.get(chatId) ?? [], seqs, false)
    if (observer.current()) await options.revalidate()
    return
  }
  if (plan.kind === 'paintLoadNewerDelta') {
    const [rows, seqs] = await Promise.all([
      chatService.getMessages(chatId, userId, 'loadNewer', NEWER_PAGE, undefined, plan.sinceSeq),
      chatService.getOtherMembersReadSeqs(chatId, userId),
    ])
    if (!deltaResultRequiresDegrade(rows.length, NEWER_PAGE)) {
      await finalize(rows, seqs, false)
      if (observer.current()) await options.revalidate()
      return
    }
  }
  const [rows, seqs] = await Promise.all([
    chatService.getMessages(chatId, userId, 'initialLoad', INITIAL_PAGE),
    chatService.getOtherMembersReadSeqs(chatId, userId),
  ])
  await finalize(rows, seqs, painted, painted || rows.length >= INITIAL_PAGE)
}
