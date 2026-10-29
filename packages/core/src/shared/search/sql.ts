import { parseSearchTerms, SearchQueryError } from './query'
import { segmentQuery } from './segment'
import type { SearchActor, SearchQuery } from './types'

export interface SearchSql { sql: string; params: (string | number)[] }

function midnight(value: string, next = false): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) throw new SearchQueryError('Search dates must be YYYY-MM-DD', 0)
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new SearchQueryError('Invalid search calendar date', 0)
  }
  if (next) date.setDate(date.getDate() + 1)
  return date.getTime() * 1000
}

/** Portable SQLite only: no driver, account lookup, IPC, model actor or network fallback. */
export function buildSearchSql(
  query: SearchQuery,
  actor: SearchActor,
  options: { limit?: number; offset?: number } = {},
): SearchSql {
  if (!actor.accountId || !actor.actorId) throw new Error('A bound search actor is required')
  const params: (string | number)[] = [actor.actorId, actor.actorId, actor.actorId]
  const where = [
    'm.deleted_at IS NULL',
    'access.hidden_for_actor = 0',
    `((scope.floor_known = 1 AND (scope.floor_at IS NULL OR m.created_at >= scope.floor_at))
      OR (scope.floor_known = 0 AND access.from_history = 1))`,
    `(m.is_whisper = 0 OR m.sender_id = ? OR EXISTS
      (SELECT 1 FROM json_each(m.to_user_ids) recipient WHERE recipient.value = ?))`,
  ]
  const positives: string[] = []
  const negatives: string[] = []
  for (const term of parseSearchTerms(query.text)) {
    const expression = segmentQuery(term.text, term.phrase)
    if (!expression) { if (!term.exclude) where.push('0'); continue }
    ;(term.exclude ? negatives : positives).push(`(${expression})`)
  }
  const fts = positives.length > 0
  if (fts) { where.push('msg_fts MATCH ?'); params.push(positives.join(' AND ')) }
  if (negatives.length) {
    where.push('m.rowid NOT IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)')
    params.push(negatives.join(' OR '))
  }
  if (query.filters.in?.length) {
    const scopes = query.filters.in.map((scope) => {
      if (scope.kind === 'session') throw new SearchQueryError('Task transcript search is not available in this message index', 0)
      if (scope.kind !== 'chat' && scope.kind !== 'topic') throw new SearchQueryError('Unknown search scope', 0)
      params.push(scope.id)
      if (scope.kind === 'chat' && scope.includeTopics !== false) {
        params.push(scope.id)
        return '(m.chat_id = ? OR chat.source_chat_id = ?)'
      }
      return 'm.chat_id = ?'
    })
    where.push(`(${scopes.join(' OR ')})`)
  }
  if (query.filters.from?.length) {
    where.push(`m.sender_id IN (${query.filters.from.map(() => '?').join(', ')})`)
    params.push(...query.filters.from)
  }
  const hasColumns = { file: 'has_file', image: 'has_image', link: 'has_link' } as const
  for (const kind of query.filters.has ?? []) {
    const column = hasColumns[kind]
    if (!column) throw new SearchQueryError('Unknown attachment filter', 0)
    where.push(`m.${column} = 1`)
  }
  for (const kind of query.filters.is ?? []) {
    if (kind === 'whisper') where.push('m.is_whisper = 1')
    else if (kind === 'mention') {
      where.push('EXISTS (SELECT 1 FROM json_each(m.to_user_ids) recipient WHERE recipient.value = ?)')
      params.push(actor.actorId)
    } else throw new SearchQueryError('Unknown message filter', 0)
  }
  if (query.filters.before) { where.push('m.created_at < ?'); params.push(midnight(query.filters.before)) }
  if (query.filters.after) { where.push('m.created_at >= ?'); params.push(midnight(query.filters.after)) }
  if (query.filters.on) {
    where.push('m.created_at >= ? AND m.created_at < ?')
    params.push(midnight(query.filters.on), midnight(query.filters.on, true))
  }
  let sql = `SELECT m.*, ${fts ? 'bm25(msg_fts)' : '0'} AS text_rank
    FROM msg m
    JOIN chat ON chat.id = m.chat_id
    JOIN actor_scope scope ON scope.chat_id = m.chat_id AND scope.actor_id = ?
    JOIN msg_actor access ON access.message_id = m.id AND access.actor_id = scope.actor_id
    ${fts ? 'JOIN msg_fts ON msg_fts.rowid = m.rowid' : ''}
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${query.sort === 'relevant' && fts ? 'text_rank ASC, ' : ''}m.created_at DESC, m.seq DESC, m.id ASC`
  if (options.limit !== undefined || options.offset !== undefined) {
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Search limit and offset must be safe nonnegative integers with a positive limit')
    }
    sql += '\n    LIMIT ? OFFSET ?'
    params.push(limit, offset)
  }
  return { sql, params }
}
