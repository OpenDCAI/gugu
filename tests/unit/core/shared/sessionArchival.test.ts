import { describe, expect, it } from 'vitest'
import { archiveTimestamp, sessionArchiveRefusesMessage, type SessionArchivalState } from '@gugu/core/shared/sessionArchival'

const state: SessionArchivalState = { sessionId: 'session', revision: 4, archivedAt: null, intervals: [
  { id: 'a', archivedAt: '2026-10-28 09:00:00', restoredAt: '2026-10-28T09:00:01.000Z' },
  { id: 'b', archivedAt: '2026-10-28T09:00:02.050Z', restoredAt: '2026-10-28T09:00:02.100Z' },
] }

describe('durable session archive intervals', () => {
  it.each([
    ['2026-10-28T08:59:59.999Z', false], ['2026-10-28T09:00:00.000Z', true],
    ['2026-10-28T09:00:00.999Z', true], ['2026-10-28T09:00:01.000Z', false],
    ['2026-10-28T09:00:02.049Z', false], ['2026-10-28T09:00:02.050Z', true],
    ['2026-10-28T09:00:02.099Z', true], ['2026-10-28T09:00:02.100Z', false],
  ] as const)('admits by the exact half-open boundaries: %s', (createdAt, refused) => {
    expect(sessionArchiveRefusesMessage(state, createdAt)).toBe(refused)
  })
  it('keeps UTC and legacy SQLite timestamps independent of the machine zone', () => {
    expect(archiveTimestamp('2026-10-28 09:00:00')).toBe(archiveTimestamp('2026-10-28T17:00:00+08:00'))
    expect(sessionArchiveRefusesMessage(state, '2026-10-28T17:00:00+08:00')).toBe(true)
  })
  it('refuses current archives without a message timestamp and leaves new sessions alone', () => {
    expect(sessionArchiveRefusesMessage({ ...state, archivedAt: state.intervals[0].archivedAt })).toBe(true)
    expect(sessionArchiveRefusesMessage(null)).toBe(false)
    expect(sessionArchiveRefusesMessage({ ...state, intervals: [] })).toBe(false)
  })
  it('fails closed on unknown timestamps or a clock rollback', () => {
    expect(() => sessionArchiveRefusesMessage(state)).toThrow('timestamp is required')
    expect(() => sessionArchiveRefusesMessage(state, 'not-a-time')).toThrow('UTC offset')
    expect(() => sessionArchiveRefusesMessage({ ...state, intervals: [{ ...state.intervals[0], restoredAt: '2026-10-27T00:00:00Z' }] }, '2026-10-28T09:00:00Z')).toThrow('backwards')
  })
})
