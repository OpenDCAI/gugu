import type { SearchCoverage, SearchCoverageReport } from './types'

/** No download progress can certify actor-specific access or an unenumerated reply stream. */
export function coverageReport(actorId: string, chatIds: readonly string[], rows: readonly SearchCoverage[]): SearchCoverageReport {
  const chats = [...new Set(chatIds)].map((chatId): SearchCoverage => {
    const row = rows.find((candidate) => candidate.actorId === actorId && candidate.chatId === chatId)
    if (!row) return { actorId, chatId, ranges: [], oldestAt: null, newestAt: null, complete: false, reasons: ['history-incomplete'] }
    if (row.complete && row.reasons.length) throw new Error('Complete search coverage cannot have incomplete reasons')
    if (!row.complete && row.reasons.length === 0) throw new Error('Incomplete search coverage requires a reason')
    return { ...row, ranges: row.ranges.map((range) => ({ ...range })), reasons: [...row.reasons] }
  })
  return { source: 'local', complete: chats.every((row) => row.complete && row.reasons.length === 0), chats }
}
