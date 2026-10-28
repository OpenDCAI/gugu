import { openFixture } from '@tooling/utils/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDb } from '@main/db/client'

const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }))
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db } }))
const { initializeSessionArchival, sessionArchivalInventory, sessionArchivalState, sessionMessageRefused, setSessionArchival } = await import('./session-archival')
let fixture: Awaited<ReturnType<typeof openFixture>>
beforeEach(async () => {
  fixture = await openFixture(); mock.db = fixture.db
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id,title) VALUES('s','p','Fixture')")
})
afterEach(() => { fixture.close(); mock.db = undefined })

describe('atomic local archival journal', () => {
  it('keeps archived sessions in the authoritative existence inventory after restart', () => {
    setSessionArchival('s', true, '2026-10-28T09:00:00Z')
    fixture.sqlite.exec("INSERT INTO sessions(id,project_id,title) VALUES('new','p','New')")
    initializeSessionArchival()
    expect(sessionArchivalInventory().map((state) => state.sessionId)).toEqual(expect.arrayContaining(['new', 's']))
    expect(sessionArchivalInventory().find((state) => state.sessionId === 's')!.archivedAt).toBe('2026-10-28T09:00:00Z')
  })
  it('persists archive, restore and a second interval without any network dependency', () => {
    setSessionArchival('s', true, '2026-10-28T09:00:00Z')
    const first = sessionArchivalState('s')!
    expect(first).toMatchObject({ archivedAt: '2026-10-28T09:00:00Z', revision: 1 })
    setSessionArchival('s', false, '2026-10-28T09:00:01Z')
    setSessionArchival('s', true, '2026-10-28T09:00:02Z')
    expect(sessionArchivalState('s')).toMatchObject({ archivedAt: '2026-10-28T09:00:02Z', revision: 3,
      intervals: [{ id: first.intervals[0].id, archivedAt: '2026-10-28T09:00:00Z', restoredAt: '2026-10-28T09:00:01Z' },
        { restoredAt: null }] })
    expect((fixture.sqlite.prepare('SELECT archived_at FROM sessions WHERE id=?').get('s') as { archived_at: string }).archived_at).toBe('2026-10-28T09:00:02Z')
  })
  it('keeps stable interval IDs across startup reconciliation and idempotent archive calls', () => {
    fixture.sqlite.exec("UPDATE sessions SET archived_at='2026-10-28 09:00:00' WHERE id='s'")
    initializeSessionArchival()
    const original = sessionArchivalState('s')
    initializeSessionArchival()
    setSessionArchival('s', true, '2026-10-28T09:00:10Z')
    expect(sessionArchivalState('s')).toEqual(original)
    setSessionArchival('s', false, '2026-10-28T09:00:11Z')
    expect(sessionArchivalState('s')!.intervals[0].id).toBe(original!.intervals[0].id)
  })
  it('rolls back a restore if the clock moved backwards', () => {
    setSessionArchival('s', true, '2026-10-28T09:00:00Z')
    const original = sessionArchivalState('s')
    expect(() => setSessionArchival('s', false, '2026-10-28T08:59:59Z')).toThrow('backwards')
    expect(sessionArchivalState('s')).toEqual(original)
  })
  it('persists refused IDs across restart without fabricating a read receipt', async () => {
    setSessionArchival('s', true, '2026-10-28T09:00:00Z')
    setSessionArchival('s', false, '2026-10-28T09:01:00Z')
    expect(sessionMessageRefused('s', 'during-archive', '2026-10-28T09:00:30Z')).toBe(true)
    vi.resetModules()
    const restarted = await import('./session-archival')
    expect(restarted.sessionMessageRefused('s', 'during-archive', '2026-10-28T09:02:00Z')).toBe(true)
    expect(restarted.sessionMessageRefused('s', 'after-restore', '2026-10-28T09:02:00Z')).toBe(false)
    expect(fixture.sqlite.prepare("SELECT value FROM kv WHERE key='session-archival-refusal:s:during-archive'").get()).toEqual({ value: 'agent_archived' })
  })
  it('does not reuse another session’s journal', () => {
    setSessionArchival('s', true, '2026-10-28T09:00:00Z')
    fixture.sqlite.exec("INSERT INTO sessions(id,project_id,title) VALUES('new','p','New')")
    expect(sessionArchivalState('new')).toEqual({ sessionId: 'new', revision: 0, archivedAt: null, intervals: [] })
  })
})
