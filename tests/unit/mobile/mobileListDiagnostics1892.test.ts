import { describe, expect, it, vi } from 'vitest'
import { createMobileListDiagnostics, type ListRowFacts, type ShellListGeometry, type ShellListState } from '../../../apps/desktop/src/mobile/mobileListDiagnostics'

const facts: ListRowFacts = { kind: 'dm', listed: true, rendered: true, searchMatch: true, owned: true,
  imActivity: false, projectedActivity: true, selected: false, draft: false }
const state: ShellListState = { activeTab: 'chats', pagerTab: 'chats', mobilePane: 'list', phoneLayerOpen: false, chatListHidden: false, tabBarVisible: true }
const geometry: ShellListGeometry = { online: true, foreground: true, viewport: [360, 766],
  shell: null, pager: null, listPane: null, list: null, me: null, scrollLeft: 0, scrollWidth: 720 }

describe('mobile list observation without content or identity', () => {
  it('distinguishes a filtered row from a row lost by the source, with stable anonymous correlation', () => {
    const record = createMobileListDiagnostics()
    record.rows([{ id: 'private-dm-uuid', facts }], false)
    record.openRow('private-dm-uuid')
    record.rows([{ id: 'private-dm-uuid', facts: { ...facts, projectedActivity: false, listed: false, rendered: false } }], false)
    record.rows([], false)
    const entries = record.recent().entries
    expect(entries.map(e => e.event)).toEqual(['rows', 'row-open', 'rows', 'rows'])
    expect(entries[1]).toMatchObject({ row: 1 })
    expect(entries[2]).toMatchObject({ sourceCount: 1, renderedCount: 0, changes: [{ row: 1, change: 'changed', listed: false, projectedActivity: false }] })
    expect(entries[3]).toMatchObject({ sourceCount: 0, changes: [{ row: 1, change: 'removed' }] })
    expect(JSON.stringify(record.recent())).not.toContain('private-dm-uuid')
  })

  it('deduplicates unchanged rows but retains load-state and shell geometry changes', () => {
    const record = createMobileListDiagnostics()
    record.rows([{ id: 'row', facts }], true)
    record.rows([{ id: 'row', facts: { ...facts } }], true)
    record.rows([{ id: 'row', facts }], false)
    record.shell('commit', state, geometry)
    record.shell('commit', { ...state }, { ...geometry })
    record.shell('commit', state, { ...geometry, scrollLeft: 180 })
    expect(record.recent().entries.map(e => e.event)).toEqual(['rows', 'rows', 'shell', 'shell'])
  })

  it('drops unapproved fields, limits changed rows and puts losses ahead of refresh additions', () => {
    const record = createMobileListDiagnostics()
    record.rows([{ id: 'secret', facts: { ...facts, message: 'private-message', email: 'private-email' } as ListRowFacts }], false)
    record.rows(Array.from({ length: 30 }, (_, n) => ({ id: `new-${n}`, facts })), false)
    const entry = record.recent().entries.at(-1)
    expect(entry).toMatchObject({ changedCount: 31 })
    if (entry?.event !== 'rows') throw new Error('missing list observation')
    expect(entry.changes).toHaveLength(12)
    expect(entry.changes[0]).toMatchObject({ row: 1, change: 'removed' })
    expect(JSON.stringify(record.recent())).not.toMatch(/private-message|private-email|secret|new-\d/)
  })

  it('bounds bursts and retained history, reports suppression, and clears data across owners', () => {
    let now = 1000
    const record = createMobileListDiagnostics(undefined, () => now)
    for (let n = 0; n < 70; n++) record.openRow('same')
    expect(record.recent().entries).toHaveLength(60)
    expect(record.recent().suppressed).toBe(10)
    now += 60_000
    record.openRow('same')
    expect(record.recent().entries.at(-1)).toMatchObject({ suppressed: 10, row: 1 })
    for (let n = 0; n < 40; n++) record.openRow('same')
    expect(record.recent().entries).toHaveLength(80)
    const copy = record.recent()
    copy.entries.length = 0
    expect(record.recent().entries).toHaveLength(80)
    record.reset()
    expect(record.recent()).toEqual({ version: 1, entries: [], suppressed: 0 })
    record.openRow('different-account-row')
    expect(record.recent().entries[0]).toMatchObject({ row: 1, sequence: 1 })
  })

  it('retains evidence without propagating a log-sink failure', () => {
    const output = vi.fn(() => { throw new Error('sink unavailable') })
    const record = createMobileListDiagnostics(output)
    expect(() => record.shell('visibility', state, geometry)).not.toThrow()
    expect(record.recent().entries).toHaveLength(1)
  })
})
