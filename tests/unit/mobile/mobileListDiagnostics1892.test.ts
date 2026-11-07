import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileListDiagnostics, type ListRowFacts, type ShellListGeometry, type ShellListState } from '../../../apps/desktop/src/mobile/mobileListDiagnostics'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const facts: ListRowFacts = { kind: 'dm', listed: true, rendered: true, searchMatch: true, owned: true,
  imActivity: false, projectedActivity: true, selected: false, draft: false }
const state: ShellListState = { activeTab: 'chats', pagerTab: 'chats', mobilePane: 'list', phoneLayerOpen: false, chatListHidden: false, tabBarVisible: true }
const geometry: ShellListGeometry = { online: true, foreground: true, viewport: [360, 766],
  shell: null, pager: null, listPane: null, list: null, me: null, scrollLeft: 0, scrollWidth: 720 }

describe('mobile list observation without content or identity', () => {
  it('distinguishes a filtered row from a row lost by the source, with stable anonymous correlation', async () => {
    const record = createMobileListDiagnostics()
    await record.rows([{ id: 'private-dm-uuid', facts }], false)
    await record.openRow('private-dm-uuid')
    await record.rows([{ id: 'private-dm-uuid', facts: { ...facts, projectedActivity: false, listed: false, rendered: false } }], false)
    await record.rows([], false)
    const entries = record.recent().entries
    expect(entries.map(e => e.event)).toEqual(['rows', 'row-open', 'rows', 'rows'])
    const hash = entries[1]?.event === 'row-open' ? entries[1].row : null
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(entries[2]).toMatchObject({ sourceCount: 1, renderedCount: 0, changes: [{ row: hash, change: 'changed', listed: false, projectedActivity: false }] })
    expect(entries[3]).toMatchObject({ sourceCount: 0, changes: [{ row: hash, change: 'removed' }] })
    expect(JSON.stringify(record.recent())).not.toContain('private-dm-uuid')
  })

  it('deduplicates unchanged rows but retains load-state and shell geometry changes', async () => {
    const record = createMobileListDiagnostics()
    await record.rows([{ id: 'row', facts }], true)
    await record.rows([{ id: 'row', facts: { ...facts } }], true)
    await record.rows([{ id: 'row', facts }], false)
    await record.shell('commit', state, geometry)
    await record.shell('commit', { ...state }, { ...geometry })
    await record.shell('commit', state, { ...geometry, scrollLeft: 180 })
    expect(record.recent().entries.map(e => e.event)).toEqual(['rows', 'rows', 'shell', 'shell'])
  })

  it('drops unapproved fields, limits changed rows and puts losses ahead of refresh additions', async () => {
    const record = createMobileListDiagnostics()
    await record.rows([{ id: 'secret', facts: { ...facts, message: 'private-message', email: 'private-email' } as ListRowFacts }], false)
    await record.rows(Array.from({ length: 30 }, (_, n) => ({ id: `new-${n}`, facts })), false)
    const first = record.recent().entries[0]
    const hash = first?.event === 'rows' ? first.changes[0]?.row : null
    const entry = record.recent().entries.at(-1)
    expect(entry).toMatchObject({ changedCount: 31 })
    if (entry?.event !== 'rows') throw new Error('missing list observation')
    expect(entry.changes).toHaveLength(12)
    expect(entry.changes[0]).toMatchObject({ row: hash, change: 'removed' })
    expect(JSON.stringify(record.recent())).not.toMatch(/private-message|private-email|secret|new-\d/)
  })

  it('bounds bursts and retained history, reports suppression, and clears data across owners', async () => {
    let now = 1000
    const record = createMobileListDiagnostics(undefined, () => now)
    for (let n = 0; n < 70; n++) await record.openRow('same')
    expect(record.recent().entries).toHaveLength(60)
    expect(record.recent().suppressed).toBe(10)
    now += 60_000
    await record.openRow('same')
    expect(record.recent().entries.at(-1)).toMatchObject({ suppressed: 10 })
    for (let n = 0; n < 40; n++) await record.openRow('same')
    expect(record.recent().entries).toHaveLength(80)
    const copy = record.recent()
    copy.entries.length = 0
    expect(record.recent().entries).toHaveLength(80)
    record.reset()
    expect(record.recent()).toEqual({ version: 1, entries: [], suppressed: 0 })
    await record.openRow('different-account-row')
    expect(record.recent().entries[0]).toMatchObject({ sequence: 1 })
  })

  it('retains evidence without propagating a log-sink failure', async () => {
    const output = vi.fn(() => { throw new Error('sink unavailable') })
    const record = createMobileListDiagnostics(output)
    await expect(record.shell('visibility', state, geometry)).resolves.toBeUndefined()
    expect(record.recent().entries).toHaveLength(1)
  })

  it('uses a random non-extractable HMAC-SHA-256 key and prevents cross-shell correlation', async () => {
    const keys = vi.spyOn(crypto.subtle, 'generateKey')
    const first = createMobileListDiagnostics(), second = createMobileListDiagnostics()
    await first.openRow('same-private-id')
    await second.openRow('same-private-id')
    const before = first.recent().entries[0]
    const digest = (entry: typeof before) => entry?.event === 'row-open' ? entry.row : null
    expect(keys).toHaveBeenCalledWith({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
    expect(digest(before)).toMatch(/^[a-f0-9]{64}$/)
    expect(digest(before)).not.toEqual(digest(second.recent().entries[0]))
    first.reset()
    await first.openRow('same-private-id')
    expect(digest(first.recent().entries[0])).not.toEqual(digest(before))
    expect(JSON.stringify(first.recent())).not.toContain('same-private-id')
  })

  it('drops a late hash from the previous account and never records hashing error text', async () => {
    let finish!: (value: ArrayBuffer) => void, entered!: () => void
    const signing = new Promise<void>(resolve => { entered = resolve })
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(() => {
      entered()
      return new Promise(resolve => { finish = resolve })
    })
    const record = createMobileListDiagnostics()
    const old = record.openRow('previous-private-account-row')
    await signing
    record.reset()
    await record.openRow('new-private-account-row')
    finish(new ArrayBuffer(32))
    await old
    expect(record.recent().entries).toHaveLength(1)
    expect(record.recent().entries[0]).toMatchObject({ sequence: 1 })
    sign.mockRejectedValueOnce(new Error('private-email-and-token'))
    await record.openRow('failed-hash-private-id')
    expect(record.recent().entries.at(-1)).toMatchObject({ event: 'row-open', row: null })
    expect(JSON.stringify(record.recent())).not.toMatch(/private-email|token|previous-private|new-private|failed-hash/)
  })
})
