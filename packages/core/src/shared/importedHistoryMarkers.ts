export const IMPORTED_HISTORY_ROOT_PREFIX = 'session-import-root:'
export const IMPORTED_HISTORY_TURN_PREFIX = 'session-import-turn:'

export type ImportedHistoryMarker = 'root' | 'turn'

const UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isImportedHistoryUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SUFFIX.test(value)
}

export function classifyImportedHistoryClientMessageId(value: unknown): ImportedHistoryMarker | null {
  if (typeof value !== 'string') return null
  if (value.startsWith(IMPORTED_HISTORY_ROOT_PREFIX)) {
    return isImportedHistoryUuid(value.slice(IMPORTED_HISTORY_ROOT_PREFIX.length)) ? 'root' : null
  }
  if (value.startsWith(IMPORTED_HISTORY_TURN_PREFIX)) {
    return isImportedHistoryUuid(value.slice(IMPORTED_HISTORY_TURN_PREFIX.length)) ? 'turn' : null
  }
  return null
}
