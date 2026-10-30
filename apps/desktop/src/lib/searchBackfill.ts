// Global search (globalSearch.v3): read each chat's history back to its beginning through the SAME
// messages_view reads the chat window uses. Those reads feed the index themselves (chat.ts); this module
// only decides which page to read next and records how far each stream has been read.
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import type { SearchCoverage } from '@gugu/core/shared/search/types'
import { feedCoverage } from './searchIndexFeed'
import { rendererLogger } from './log'

const log = rendererLogger('search-backfill')

const PAGE = 100
const PAGE_INTERVAL_MS = 200
const RETRY_MS = 5000

export interface SearchBackfillSource {
  coverage(): Promise<SearchCoverage[]>
  mainPage(chatId: string, beforeSeq?: number, afterSeq?: number): Promise<MessageItem[]>
  threadPage(chatId: string, rootId: string, beforeSeq?: number): Promise<MessageItem[]>
}

export interface SearchBackfillHost {
  chats(): readonly ChatItem[]
  /** The open chat goes first. */
  activeChatId(): string | null
  /** Reading pauses while this is false (window hidden, offline). */
  canRead(): boolean
  sleep(ms: number): Promise<void>
}

const key = (chatId: string, threadRootId: string | null) => `${chatId}\u0000${threadRootId ?? ''}`

export function startSearchBackfill(source: SearchBackfillSource, host: SearchBackfillHost): () => void {
  let stopped = false
  const streams = new Map<string, SearchCoverage>()

  async function readable(): Promise<boolean> {
    while (!stopped && !host.canRead()) await host.sleep(RETRY_MS)
    return !stopped
  }

  async function record(coverage: SearchCoverage): Promise<void> {
    streams.set(key(coverage.chatId, coverage.threadRootId), coverage)
    await feedCoverage(coverage)
  }

  function remember(chatId: string, page: readonly MessageItem[]): Promise<void>[] {
    return page.filter((message) => message.is_thread_root && !streams.has(key(chatId, message.id))).map((root) =>
      record({ chatId, threadRootId: root.id, oldestSeq: null, newestSeq: null, exhausted: false }))
  }

  // Streams already read in an earlier run first catch up on rows newer than they reached (once per start).
  const caughtUp = new Set<string>()

  async function readStream(start: SearchCoverage): Promise<void> {
    let coverage = start
    const { chatId, threadRootId } = coverage
    while (threadRootId === null && !caughtUp.has(chatId) && coverage.newestSeq !== null && await readable()) {
      const page = await source.mainPage(chatId, undefined, coverage.newestSeq)
      await Promise.all(remember(chatId, page))
      if (page.length === 0) break
      coverage = { ...coverage, newestSeq: Math.max(...page.map((message) => message.seq)) }
      await record(coverage)
      await host.sleep(PAGE_INTERVAL_MS)
      if (page.length < PAGE) break
    }
    if (threadRootId === null && !caughtUp.has(chatId) && !stopped) {
      caughtUp.add(chatId)
      // Reported even when nothing was newer: the index counts a chat as read through only after this run said so.
      if (coverage.newestSeq !== null) await record(coverage)
    }
    // Then older history, until a page comes back empty.
    while (!coverage.exhausted && await readable()) {
      const before = coverage.oldestSeq ?? undefined
      const page = threadRootId === null
        ? await source.mainPage(chatId, before)
        : await source.threadPage(chatId, threadRootId, before)
      if (threadRootId === null) await Promise.all(remember(chatId, page))
      const seqs = page.map((message) => message.seq).filter((seq) => seq > 0)
      coverage = seqs.length === 0 ? { ...coverage, exhausted: true } : {
        ...coverage,
        oldestSeq: Math.min(...seqs),
        newestSeq: Math.max(coverage.newestSeq ?? 0, ...seqs),
      }
      await record(coverage)
      await host.sleep(PAGE_INTERVAL_MS)
    }
  }

  function next(): SearchCoverage | null {
    const active = host.activeChatId()
    const chats = [...host.chats()].sort((a, b) => Number(b.id === active) - Number(a.id === active)
      || (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
    for (const chat of chats) {
      const main = streams.get(key(chat.id, null))
        ?? { chatId: chat.id, threadRootId: null, oldestSeq: null, newestSeq: null, exhausted: false }
      if (!main.exhausted || !caughtUp.has(chat.id)) return main
      for (const stream of streams.values()) if (stream.chatId === chat.id && !stream.exhausted) return stream
    }
    return null
  }

  void (async () => {
    for (const coverage of await source.coverage()) streams.set(key(coverage.chatId, coverage.threadRootId), coverage)
    while (!stopped) {
      const stream = next()
      if (!stream) { await host.sleep(RETRY_MS); continue }
      try {
        await readStream(stream)
      } catch (error) {
        log.warn({ error: String(error) }, 'page failed; retrying')
        await host.sleep(RETRY_MS)
      }
    }
  })().catch((error: unknown) => log.error({ error: String(error) }, 'stopped'))

  return () => { stopped = true }
}
