import { parseSearchTerms, SearchQueryError } from './query'
import { segmentQuery } from './segment'
import type { SearchQuery } from './types'

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

/**
 * Portable SQLite only: no driver, IPC or network fallback. Every stored row is already visible to the
 * account (see schema.ts), so the SQL only matches and filters; it does not re-decide visibility.
 */
export function buildSearchSql(
  query: SearchQuery,
  accountId: string,
  /** unordered: for counting, so SQLite can stop at the limit instead of sorting every match. */
  options: { limit?: number; offset?: number; unordered?: boolean } = {},
): SearchSql {
  if (!accountId) throw new Error('A signed-in search account is required')
  const params: (string | number)[] = []
  const where: string[] = []
  const positives: string[] = []
  const negatives: string[] = []
  for (const term of parseSearchTerms(query.text)) {
    const expression = segmentQuery(term.text, term.phrase)
    if (!expression) { if (!term.exclude) where.push('0'); continue }
    const list = term.exclude ? negatives : positives
    list.push(`(${expression})`)
  }
  const fts = positives.length > 0
  if (fts) { where.push('msg_fts MATCH ?'); params.push(positives.join(' AND ')) }
  if (negatives.length) {
    where.push('m.rowid NOT IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)')
    params.push(negatives.join(' OR '))
  }
  if (query.filters.in?.length) {
    const scopes = query.filters.in.map((scope) => {
      if (scope.kind === 'session') { params.push(scope.id); return 'm.task_id = ?' }
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
  if (query.filters.kind) where.push(query.filters.kind === 'task' ? 'm.task_id IS NOT NULL' : 'm.chat_id IS NOT NULL')
  if (query.filters.from?.length) {
    where.push(`(CASE WHEN m.role = 'assistant' THEN task.agent_user_id ELSE m.sender_id END) IN (${query.filters.from.map(() => '?').join(', ')})`)
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
      params.push(accountId)
    } else throw new SearchQueryError('Unknown message filter', 0)
  }
  if (query.filters.before) { where.push('m.created_at < ?'); params.push(midnight(query.filters.before)) }
  if (query.filters.after) { where.push('m.created_at >= ?'); params.push(midnight(query.filters.after)) }
  if (query.filters.on) {
    where.push('m.created_at >= ? AND m.created_at < ?')
    params.push(midnight(query.filters.on), midnight(query.filters.on, true))
  }
  let sql = `SELECT m.id,m.chat_id,m.task_id,m.message_ref,m.role,m.thread_root_id,m.seq,
    CASE WHEN m.role = 'assistant' THEN task.agent_user_id ELSE m.sender_id END AS sender_id,
    m.created_at,m.created_at_iso,m.text,m.is_whisper,m.to_user_ids,m.has_file,m.has_image,m.has_link,
    task.title AS task_title,task.project_id,task.archived, ${fts ? 'bm25(msg_fts)' : '0'} AS text_rank
    FROM msg m
    LEFT JOIN chat ON chat.id = m.chat_id
    LEFT JOIN task ON task.id = m.task_id
    ${fts ? 'JOIN msg_fts ON msg_fts.rowid = m.rowid' : ''}
    WHERE ${where.length ? where.join('\n      AND ') : '1'}
    ${options.unordered ? '' : `ORDER BY ${query.sort === 'relevant' && fts ? 'text_rank ASC, ' : ''}m.created_at DESC NULLS LAST, m.seq DESC, m.id ASC`}`
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
