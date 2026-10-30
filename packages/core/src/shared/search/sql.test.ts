import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SEARCH_SCHEMA_SQL } from './schema'
import { segment } from './segment'
import { buildSearchSql } from './sql'
import { searchTimestampMicros } from './time'
import type { SearchQuery } from './types'

const open: DatabaseSync[] = []
afterEach(() => { for (const db of open.splice(0)) db.close() })

function fixture() {
  const db = new DatabaseSync(':memory:')
  open.push(db)
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SEARCH_SCHEMA_SQL)
  db.exec(`INSERT INTO chat VALUES ('g','group',NULL),('t','topic','g'),('other','group',NULL);`)
  function put(id: string, text: string, options: { chat?: string; to?: string[]; whisper?: boolean; seq?: number; at?: string; sender?: string; has?: NonNullable<SearchQuery['filters']['has']> } = {}) {
    const seq = options.seq ?? 1
    const at = options.at ?? '2026-10-29T12:00:00Z'
    const has = options.has ?? ['file']
    db.prepare(`INSERT INTO msg(id,chat_id,thread_root_id,seq,sender_id,created_at,created_at_iso,text,body,is_whisper,to_user_ids,has_file,has_image,has_link)
      VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, options.chat ?? 'g', seq, options.sender ?? 'peer', searchTimestampMicros(at), at, text, segment(text), options.whisper ? 1 : 0, JSON.stringify(options.to ?? []), Number(has.includes('file')), Number(has.includes('image')), Number(has.includes('link')))
  }
  function query(text: string, filters: SearchQuery['filters'] = {}, sort: SearchQuery['sort'] = 'recent') {
    const { sql, params } = buildSearchSql({ text, filters, sort }, 'owner')
    return (db.prepare(sql).all(...params) as { id: string }[]).map((row) => row.id)
  }
  return { db, put, query }
}

describe('shared SQL on real SQLite FTS5', () => {
  it('finds one/two-character phrases inside longer Han text, including cross-word substrings', () => {
    const { put, query } = fixture()
    put('plan', '發佈計劃')
    put('nonphrase', '发新消息布置')
    expect(query('发布')).toEqual(['plan'])
    expect(query('布计')).toEqual(['plan'])
    expect(query('布')).toEqual(['nonphrase', 'plan'])
  })

  it('keeps the external-content index in sync through body replacement and deletion', () => {
    const { db, put, query } = fixture()
    put('message', '發布')
    db.prepare('UPDATE msg SET text=?,body=? WHERE id=?').run('完成', segment('完成'), 'message')
    expect(query('发布')).toEqual([])
    expect(query('完成')).toEqual(['message'])
    db.prepare('DELETE FROM msg WHERE id=?').run('message')
    expect(query('完成')).toEqual([])
  })



  it('returns original ISO timestamps while sorting and filtering by exact microseconds', () => {
    const { db, put } = fixture()
    const messages = [
      { id: 'early', at: '2026-10-20T12:00:00.000100Z' },
      { id: 'offset', at: '2026-10-20T14:00:00.000500+02:00' },
      { id: 'late', at: '2026-10-20T12:00:00.000900Z' },
    ]
    for (const message of messages) put(message.id, 'needle', { at: message.at })
    const query = buildSearchSql({ text: 'needle', filters: {}, sort: 'recent' }, 'owner')
    const rows = () => (db.prepare(query.sql).all(...query.params) as { id: string; created_at_iso: string; created_at: number }[])
      .map((row) => ({ id: row.id, at: row.created_at_iso, micros: row.created_at }))
    const expected = messages.toReversed().map(({ id, at }) => ({ id, at, micros: searchTimestampMicros(at) }))
    expect(rows()).toEqual(expected)
  })


  it('binds filters, inherits included topics and never turns origin into an implicit filter', () => {
    const { db, put, query } = fixture()
    put('main', 'release needle', { to: ['owner'] })
    put('topic', 'release needle', { chat: 't' })
    put('elsewhere', 'release needle', { chat: 'other' })
    expect(query('needle', { in: [{ kind: 'chat', id: 'g' }] })).toEqual(['main', 'topic'])
    expect(query('needle', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] })).toEqual(['main'])
    expect(query('needle', { has: ['file'], is: ['mention'], from: ['peer'] })).toEqual(['main'])
    put('whisper', 'release needle', { whisper: true, to: ['owner'] })
    expect(query('needle', { is: ['whisper'] })).toEqual(['whisper'])
    expect(query('needle', { from: ["peer') OR 1=1 --"] })).toEqual([])
    const result = buildSearchSql({ text: 'needle', filters: {}, sort: 'recent', origin: { chatId: 'g' } }, 'owner')
    expect(db.prepare(result.sql).all(...result.params)).toHaveLength(4)
    expect(() => query('needle', { in: [{ kind: 'session', id: 'task' }] })).toThrow(/not available/)
  })

  it('combines attachment requirements and excludes a different valid sender', () => {
    const { put, query } = fixture()
    put('file', 'needle')
    put('image', 'needle', { has: ['image'] })
    put('link', 'needle', { has: ['link'] })
    put('both', 'needle', { has: ['image', 'link'] })
    put('other-sender', 'needle', { has: ['image', 'link'], sender: 'other-peer' })
    expect(query('needle', { has: ['image'], from: ['peer'] })).toEqual(['both', 'image'])
    expect(query('needle', { has: ['link'], from: ['peer'] })).toEqual(['both', 'link'])
    expect(query('needle', { has: ['image', 'link'], from: ['peer'] })).toEqual(['both'])
    expect(query('needle', { has: ['file', 'image'] })).toEqual([])
  })

  it.each([
    { day: '2026-10-29', month: 9, date: 29 },
    { day: '2026-11-01', month: 10, date: 1 },
  ])('binds on/before/after to local calendar midnights for $day', ({ day, month, date }) => {
    const { put, query } = fixture()
    const start = new Date(2026, month, date).getTime()
    const next = new Date(2026, month, date + 1).getTime()
    put('before', 'needle', { at: new Date(start - 1).toISOString() })
    put('start', 'needle', { at: new Date(start).toISOString() })
    put('last', 'needle', { at: new Date(next - 1).toISOString() })
    put('next', 'needle', { at: new Date(next).toISOString() })
    expect(query('needle', { on: day })).toEqual(['last', 'start'])
    expect(query('needle', { before: day })).toEqual(['before'])
    expect(query('needle', { after: day })).toEqual(['next', 'last', 'start'])
    expect(query('needle', { after: day, before: day })).toEqual([])
  })

  it('distinguishes FTS relevance from recency on the same matching rows', () => {
    const { put, query } = fixture()
    put('older-relevant', 'needle needle needle needle', { at: '2026-10-28T12:00:00Z' })
    put('newer', `needle ${'filler '.repeat(32)}`, { at: '2026-10-29T12:00:00Z' })
    expect(query('needle', {}, 'relevant')).toEqual(['older-relevant', 'newer'])
    expect(query('needle', {}, 'recent')).toEqual(['newer', 'older-relevant'])
  })

  it('handles exclusion-only, quoted phrases, date-only queries and empty searchable text safely', () => {
    const { put, query } = fixture()
    put('kept', 'release plan')
    put('draft', 'release draft plan')
    expect(query('release -draft')).toEqual(['kept'])
    expect(query('-draft')).toEqual(['kept'])
    expect(query('"release plan"')).toEqual(['kept'])
    expect(query('', { on: '2026-10-29' })).toEqual(['draft', 'kept'])
    expect(query('😀')).toEqual([])
    expect(query('OR')).toEqual([])
    expect(() => query('', { on: '2026-02-30' })).toThrow(/Invalid/)
  })
})
