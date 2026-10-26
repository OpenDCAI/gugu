import type { MessageItem } from '@gugu/core/shared/types/chat'
import { imSelectors, type AccountImRepository, type ImRepositoryTransaction } from './imRepository'

type Interval = { lower: number; upper: number }
type Coverage = { ranges: Interval[]; tail: number | null }
export type HistoryPageQuery = { chatId: string; direction: 'older' | 'newer' | 'latest'; cursor: number; limit: number }
const coverageKey = (chatId: string) => `history:main:${chatId}`
const deletedKey = (id: string) => `history-deleted:${id}`

export class HistoryNotDownloadedError extends Error {
  constructor() { super('This history has not been downloaded to this device. Connect to download it.') }
}

function coverage(repository: AccountImRepository, chatId: string): Coverage {
  return imSelectors.view(coverageKey(chatId))(repository.snapshot()) as Coverage | undefined ?? { ranges: [], tail: null }
}

export function mergeHistoryRanges(ranges: readonly Interval[], incoming: Interval): Interval[] {
  const merged: Interval[] = []
  for (const range of [...ranges, incoming].sort((a, b) => a.lower - b.lower)) {
    const last = merged.at(-1)
    if (last && range.lower <= last.upper + 1) last.upper = Math.max(last.upper, range.upper)
    else merged.push({ ...range })
  }
  return merged
}

/** A gap in visible seq values is not a missing page. Only a server page proves coverage. */
export async function readHistoryPage(repository: AccountImRepository, query: HistoryPageQuery): Promise<MessageItem[] | null> {
  const { chatId, direction, cursor, limit } = query
  const known = coverage(repository, chatId)
  const point = direction === 'older' ? cursor - 1 : direction === 'newer' ? cursor + 1 : known.tail
  if (point === null) return null
  if (direction === 'newer' && known.tail !== null && cursor >= known.tail) return []
  const range = known.ranges.find((range) => range.lower <= point && range.upper >= point)
  if (!range) return null
  const ascending = direction === 'newer'
  const lower = ascending ? point : range.lower
  const upper = ascending ? range.upper : point
  const rows = await repository.readMessageRange(`main:${chatId}`, lower, upper, limit, ascending)
  if (rows.length < limit && (ascending ? range.upper !== known.tail : range.lower !== 1)) return null
  const messages = rows.map((row) => row.value)
  return ascending ? messages : messages.reverse()
}

/** Body rows and the authority to answer a range are one durable transaction. */
export async function retainHistoryPage(repository: AccountImRepository, query: HistoryPageQuery, messages: MessageItem[], rowCount: number): Promise<void> {
  if (rowCount !== messages.length) throw new Error('Cannot certify a history page containing unmapped message rows')
  const { chatId, direction, cursor, limit } = query
  if (messages.some((row) => row.chat_id !== chatId || row.thread_root_id || row.seq < 1)) throw new Error('History page crossed its stream')
  const min = messages[0]?.seq
  const max = messages.at(-1)?.seq
  const lower = direction === 'newer' ? cursor + 1 : rowCount < limit ? 1 : min
  const upper = direction === 'older' ? cursor - 1 : max ?? (direction === 'latest' ? 0 : cursor)
  await repository.transaction((transaction) => {
    const current = repository.snapshot()
    const resident = new Set(current.message.map((row) => row.id))
    for (const row of messages) {
      if (imSelectors.view(deletedKey(row.id))(current) !== undefined) continue
      transaction.putMessage(row, !resident.has(row.id))
    }
    const previous = coverage(repository, chatId)
    transaction.putView(coverageKey(chatId), {
      ranges: lower !== undefined && lower <= upper ? mergeHistoryRanges(previous.ranges, { lower, upper }) : previous.ranges,
      tail: direction === 'latest' || (direction === 'newer' && rowCount < limit) ? max ?? cursor : previous.tail,
    } satisfies Coverage)
  })
}

/** Confirmed deletion survives window eviction and races with an older in-flight page. */
export function retainMessageDeletion(repository: AccountImRepository, transaction: ImRepositoryTransaction, id: string): void {
  transaction.delete('message', [repository.accountId, id])
  transaction.putView(deletedKey(id), true)
  const row = repository.snapshot().message.find((row) => row.id === id)
  if (!row) return
  const key = `message-window:${row.chatId}`
  const window = imSelectors.view(key)(repository.snapshot()) as { hasMoreOlder: boolean } | undefined
  if (!window) return
  const seqs = repository.snapshot().message.filter((other) => other.streamId === row.streamId && other.id !== id).map((row) => row.seq)
  transaction.putView(key, { ...window, oldestSeq: seqs.length ? Math.min(...seqs) : 0, maxSeq: seqs.length ? Math.max(...seqs) : 0 })
}
