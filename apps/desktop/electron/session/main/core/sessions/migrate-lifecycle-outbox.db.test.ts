import { openFixture } from '@tooling/utils/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDb } from '@main/db/client'
import { sessions } from '@main/db/schema'

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }))

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized')
    return mocks.db
  },
}))
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }))

import { log } from '@main/lib/logger'
import { migrateStrandedLifecycleOutbox } from './migrate-lifecycle-outbox'

describe('lifecycle outbox entries left by an older version', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>

  beforeEach(async () => {
    fixture = await openFixture('empty')
    mocks.db = fixture.db
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('conversation-1', 'project-1', 'Conversation', 'codex', 'acp',
          '{"version":"1","type":"acp","messageOutbox":[{"id":"life-1","text":"stopped","kind":"lifecycle","state":"dispatching"},{"id":"msg-1","text":"hello","kind":"ordinary","state":"pending"},{"id":"life-2","text":"running","kind":"lifecycle","state":"pending"}]}');
      INSERT INTO messages (id, session_id, content, sender, metadata)
        VALUES ('life-1', 'conversation-1', 'stopped', 'system', '{"kind":"session-lifecycle","state":"dispatching"}');
    `)
  })

  afterEach(() => {
    fixture.close()
    mocks.db = undefined
  })

  const config = () => fixture.db.select({ config: sessions.config }).from(sessions).all()[0].config

  it('a config holding one does not parse before the migration', () => {
    expect(config()).toBeNull()
  })

  it('removes them once, keeps the other entries and the messages rows, and the config parses', () => {
    expect(migrateStrandedLifecycleOutbox()).toBe(2)
    expect(config()).toMatchObject({ messageOutbox: [{ id: 'msg-1', text: 'hello', kind: 'ordinary', state: 'pending' }] })
    expect(fixture.sqlite.prepare('SELECT metadata FROM messages WHERE id = ?').get('life-1')).toEqual({
      metadata: '{"kind":"session-lifecycle","state":"dispatching"}',
    })
    expect(migrateStrandedLifecycleOutbox()).toBe(0)
  })

  it('a config that is not JSON, or does not parse without those entries, is logged and left as it is; the rest still migrate', () => {
    const broken = '{"version":"1","type":"acp","messageOutbox":[{"kind":"lifecycle"'
    const invalid = '{"version":"1","type":"nope","messageOutbox":[{"id":"life-3","text":"x","kind":"lifecycle"}]}'
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, title, provider, runtime, config) VALUES (?, 'project-1', 'Broken', 'codex', 'acp', ?)`).run('broken-1', broken)
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, title, provider, runtime, config) VALUES (?, 'project-1', 'Invalid', 'codex', 'acp', ?)`).run('invalid-1', invalid)

    expect(migrateStrandedLifecycleOutbox()).toBe(2)
    const raw = (id: string) => (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string }).config
    expect(raw('broken-1')).toBe(broken)
    expect(raw('invalid-1')).toBe(invalid)
    expect(vi.mocked(log.warn).mock.calls.map(([message, fields]) => [message, (fields as { sessionId?: string }).sessionId]))
      .toEqual(expect.arrayContaining([
        ['session config is not JSON; lifecycle outbox entries left in place', 'broken-1'],
        ['session config does not parse even without its lifecycle outbox entries; left in place', 'invalid-1'],
      ]))
    expect(config()).toMatchObject({ messageOutbox: [{ id: 'msg-1' }] })
  })
})
