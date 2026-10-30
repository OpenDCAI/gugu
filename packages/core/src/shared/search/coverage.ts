import type { SearchCoverage, SearchCoverageReport } from './types'

/** A chat counts as complete once its main timeline has been read back to the beginning. */
export function coverageReport(chatIds: readonly string[], rows: readonly SearchCoverage[]): SearchCoverageReport {
  const chats = [...new Set(chatIds)].map((chatId): SearchCoverage =>
    rows.find((row) => row.chatId === chatId && row.threadRootId === null)
      ?? { chatId, threadRootId: null, oldestSeq: null, newestSeq: null, exhausted: false })
  return { complete: chats.every((row) => row.exhausted), chats }
}
