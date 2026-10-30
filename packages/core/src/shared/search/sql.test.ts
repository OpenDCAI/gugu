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
  db.exec(`INSERT INTO chat VALUES ('g','group','group',NULL),('t','topic','topic','g'),('other','other','group',NULL);
    INSERT INTO actor_scope VALUES ('owner','g',1,NULL),('owner','t',1,NULL),('owner','other',1,NULL),('agent','g',0,NULL);`)
  function put(id: string, text: string, options: { chat?: string; to?: string[]; whisper?: boolean; seq?: number; at?: string } = {}) {
    const seq = options.seq ?? 1
    const at = options.at ?? '2026-10-29T12:00:00Z'
    db.prepare(`INSERT INTO msg(id,chat_id,thread_root_id,seq,sender_id,created_at,created_at_iso,text,body,is_whisper,to_user_ids,deleted_at,has_file,has_image,has_link)
      VALUES (?,?,NULL,?,'peer',?,?,?,?, ?,?,NULL,1,0,0)`)
      .run(id, options.chat ?? 'g', seq, searchTimestampMicros(at), at, text, segment(text), options.whisper ? 1 : 0, JSON.stringify(options.to ?? []))
    db.prepare('INSERT INTO msg_actor VALUES (?,?,0,0)').run('owner', id)
  }
  function query(text: string, filters: SearchQuery['filters'] = {}, actorId = 'owner') {
    const { sql, params } = buildSearchSql({ text, filters, sort: 'recent' }, { accountId: 'owner', actorId })
    return db.prepare(sql).all(...params).map((row) => row.id)
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
    expect(db.prepare('SELECT * FROM msg_actor').all()).toEqual([])
  })

  it('requires exact actor scope, hidden metadata and history proof, with whisper checks afterwards', () => {
    const { db, put, query } = fixture()
    put('public', 'needle')
    put('whisper', 'needle', { whisper: true, to: ['owner'] })
    db.exec(`INSERT INTO msg_actor SELECT 'agent',id,1,0 FROM msg;`)
    expect(query('needle', {}, 'agent')).toEqual(['public'])
    db.exec(`UPDATE msg_actor SET hidden_for_actor=NULL WHERE actor_id='agent'`)
    expect(query('needle', {}, 'agent')).toEqual([])
    db.exec(`UPDATE msg_actor SET hidden_for_actor=0,from_history=0 WHERE actor_id='agent'`)
    expect(query('needle', {}, 'agent')).toEqual([])
    expect(query('needle')).toEqual(['public', 'whisper'])
    db.exec(`DELETE FROM actor_scope WHERE actor_id='owner'`)
    expect(query('needle')).toEqual([])
  })

  it('does not round a pre-floor message up into a membership boundary', () => {
    const { db, put, query } = fixture()
    put('early', 'needle', { at: '2026-10-20T12:00:00.000100Z' })
    db.prepare("UPDATE actor_scope SET floor_at=? WHERE actor_id='owner' AND chat_id='g'")
      .run(searchTimestampMicros('2026-10-20T12:00:00.000900Z'))
    expect(query('needle')).toEqual([])
  })

  it('returns original ISO timestamps while sorting and filtering by exact microseconds', () => {
    const { db, put } = fixture()
    const messages = [
      { id: 'early', at: '2026-10-20T12:00:00.000100Z' },
      { id: 'offset', at: '2026-10-20T14:00:00.000500+02:00' },
      { id: 'late', at: '2026-10-20T12:00:00.000900Z' },
    ]
    for (const message of messages) put(message.id, 'needle', { at: message.at })
    const query = buildSearchSql({ text: 'needle', filters: {}, sort: 'recent' }, { accountId: 'owner', actorId: 'owner' })
    const rows = () => db.prepare(query.sql).all(...query.params)
      .map((row) => ({ id: row.id, at: row.created_at_iso, micros: row.created_at }))
    const expected = messages.toReversed().map(({ id, at }) => ({ id, at, micros: searchTimestampMicros(at) }))
    expect(rows()).toEqual(expected)
    db.prepare("UPDATE actor_scope SET floor_at=? WHERE actor_id='owner' AND chat_id='g'")
      .run(searchTimestampMicros('2026-10-20T12:00:00.000500Z'))
    expect(rows()).toEqual(expected.slice(0, 2))
  })

  it('binds filters, inherits included topics and never turns origin into an implicit filter', () => {
    const { db, put, query } = fixture()
    put('main', 'release needle', { to: ['owner'] })
    put('topic', 'release needle', { chat: 't' })
    put('elsewhere', 'release needle', { chat: 'other' })
    expect(query('needle', { in: [{ kind: 'chat', id: 'g' }] })).toEqual(['main', 'topic'])
    expect(query('needle', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] })).toEqual(['main'])
    expect(query('needle', { has: ['file'], is: ['mention'], from: ['peer'] })).toEqual(['main'])
    expect(query('needle', { from: ["peer') OR 1=1 --"] })).toEqual([])
    const result = buildSearchSql({ text: 'needle', filters: {}, sort: 'recent', origin: { chatId: 'g' } }, { accountId: 'owner', actorId: 'owner' })
    expect(db.prepare(result.sql).all(...result.params)).toHaveLength(3)
    expect(() => query('needle', { in: [{ kind: 'session', id: 'task' }] })).toThrow(/not available/)
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
