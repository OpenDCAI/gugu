import { describe, expect, it } from 'vitest'
import { coverageReport } from './coverage'
import type { SearchCoverage } from './types'

const complete: SearchCoverage = {
  actorId: 'owner', chatId: 'group', ranges: [{ threadRootId: null, oldestSeq: 2, newestSeq: 200 }],
  oldestAt: '2026-10-01T00:00:00Z', newestAt: '2026-10-29T00:00:00Z', complete: true, reasons: [],
}

describe('actor-specific confirmed coverage', () => {
  it('does not infer another actor coverage or a missing chat from downloaded bodies', () => {
    expect(coverageReport('agent', ['group'], [complete])).toMatchObject({ complete: false, chats: [{ reasons: ['history-incomplete'] }] })
    expect(coverageReport('owner', ['group', 'other'], [complete]).complete).toBe(false)
    expect(coverageReport('owner', ['group'], [complete]).complete).toBe(true)
  })
  it.each(['visibility-unverified', 'threads-unverified', 'cleared', 'stale'] as const)
    ('keeps raw intervals but does not report completeness for %s', (reason) => {
      const report = coverageReport('owner', ['group'], [{ ...complete, complete: false, reasons: [reason] }])
      expect(report.complete).toBe(false)
      expect(report.chats[0].ranges).toEqual(complete.ranges)
    })
  it('rejects a contradictory completeness claim and copies its result', () => {
    expect(() => coverageReport('owner', ['group'], [{ ...complete, reasons: ['visibility-unverified'] }])).toThrow(/cannot/)
    const report = coverageReport('owner', ['group'], [complete])
    report.chats[0].ranges[0].oldestSeq = 9
    expect(complete.ranges[0].oldestSeq).toBe(2)
  })
})
