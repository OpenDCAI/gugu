/** Archive intervals describe refusal, independently of message read receipts. */
export interface SessionArchiveInterval {
  id: string
  archivedAt: string
  restoredAt: string | null
}

/** Cloud receipt for the identity removed by this archive, retained until identity replacement succeeds. */
export interface RemovedSessionIdentity {
  userId: string
  removedAt: string
}

export interface SessionArchivalState {
  sessionId: string
  archivedAt: string | null
  revision: number
  intervals: SessionArchiveInterval[]
  removedIdentity?: RemovedSessionIdentity | null
}

export class SessionArchivedError extends Error {
  readonly code = 'SESSION_ARCHIVED'
  constructor() { super('Recipient is archived'); this.name = 'SessionArchivedError' }
}

/** SQLite's legacy CURRENT_TIMESTAMP is UTC although it carries no zone. */
export function archiveTimestamp(value: string): number {
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error('Session archival timestamp has no explicit UTC offset')
  }
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) throw new Error('Session archival timestamp is invalid')
  return timestamp
}

export function sessionArchiveRefusesMessage(state: SessionArchivalState | null, createdAt?: string): boolean {
  if (!state) return false
  if (state.archivedAt !== null) return true
  if (state.intervals.length === 0) return false
  // No timestamp while historical intervals exist is unknown, not permission.
  if (!createdAt) throw new Error('Message timestamp is required for session archival admission')
  const timestamp = archiveTimestamp(createdAt)
  return state.intervals.some((interval) => {
    const start = archiveTimestamp(interval.archivedAt)
    const end = interval.restoredAt === null ? Infinity : archiveTimestamp(interval.restoredAt)
    if (end < start) throw new Error('Session archival clock moved backwards')
    return timestamp >= start && timestamp < end
  })
}
