import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import type { SearchCoverage } from '@gugu/core/shared/search/types'

const { coverage } = vi.hoisted(() => ({ coverage: [] as SearchCoverage[] }))
vi.mock('../../../../apps/desktop/src/lib/searchIndexFeed', () => ({
  feedCoverage: async (row: SearchCoverage) => { coverage.push(row) },
}))
import { startSearchBackfill, type SearchBackfillSource } from '../../../../apps/desktop/src/lib/searchBackfill'

const message = (seq: number, extra: Partial<MessageItem> = {}) => ({ id: `m${seq}`, seq, is_thread_root: false, ...extra }) as MessageItem
const chat = (id: string, last: string) => ({ id, last_message_at: last }) as ChatItem

function run(source: SearchBackfillSource, chats: ChatItem[], options: { active?: string; canRead?: () => boolean } = {}) {
  let idle!: () => void
  const done = new Promise<void>((resolve) => { idle = resolve })
  const stop = startSearchBackfill(source, {
    chats: () => chats, activeChatId: () => options.active ?? null, canRead: options.canRead ?? (() => true),
    sleep: async (ms) => { if (ms >= 5000) idle() },
  })
  return done.then(stop)
}

describe('search backfill', () => {
  it('reads each chat from newest to oldest until an empty page, open chat first, then its threads', async () => {
    coverage.length = 0
    const calls: string[] = []
    const pages: Record<string, MessageItem[][]> = {
      a: [[message(5), message(6, { is_thread_root: true })], [message(1)], []],
      b: [[]],
    }
    await run({
      coverage: async () => [],
      mainPage: async (chatId, before) => { calls.push(`${chatId}<${before ?? '-'}`); return pages[chatId]!.shift() ?? [] },
      threadPage: async (chatId, root, before) => { calls.push(`${chatId}/${root}<${before ?? '-'}`); return [] },
    }, [chat('a', '2026-10-01'), chat('b', '2026-10-30')], { active: 'a' })
    expect(calls).toEqual(['a<-', 'a<5', 'a<1', 'a/m6<-', 'b<-'])
    expect(coverage.filter((row) => row.chatId === 'a' && row.threadRootId === null).at(-1))
      .toEqual({ chatId: 'a', threadRootId: null, oldestSeq: 1, newestSeq: 6, exhausted: true })
  })

  it('catches up on newer rows once per start for a chat already read', async () => {
    const calls: string[] = []
    await run({
      coverage: async () => [{ chatId: 'a', threadRootId: null, oldestSeq: 1, newestSeq: 9, exhausted: true }],
      mainPage: async (chatId, before, after) => { calls.push(`>${after}`); return after === 9 ? [message(10)] : [] },
      threadPage: async () => [],
    }, [chat('a', '2026-10-30')])
    expect(calls).toEqual(['>9'])
  })

  it('does not read while reading is paused', async () => {
    const mainPage = vi.fn(async () => [])
    await run({ coverage: async () => [], mainPage, threadPage: async () => [] }, [chat('a', '2026-10-30')], { canRead: () => false })
    expect(mainPage).not.toHaveBeenCalled()
  })
})
