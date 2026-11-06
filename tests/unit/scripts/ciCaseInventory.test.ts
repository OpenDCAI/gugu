import { describe, expect, it } from 'vitest'
import { caseInventory, compareCaseInventories } from '../../../scripts/ci/compare-vitest-cases.mjs'

const report = (statuses = ['passed', 'skipped', 'passed'], file = '/source/tests/a.test.ts') => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: statuses.length,
  testResults: [{ name: file, status: 'passed', assertionResults: statuses.map(status => ({ fullName: 'suite > parameter', status })) }],
})
const inventory = (value: ReturnType<typeof report>[]) => caseInventory(value, '/source')

describe('full CI case inventory', () => {
  it('compares duplicate parameterized names as a multiset and retains conditional skips', () => {
    const before = inventory([report()]), after = inventory([report(['skipped', 'passed', 'passed'])])
    expect(compareCaseInventories(before, after)).toMatchObject({ equal: true, healthy: true,
      baseline: { files: 1, statuses: { passed: 2, skipped: 1 } } })
  })
  it('fails equality for a new skip, missing case or different file even with equal totals', () => {
    const before = inventory([report()])
    for (const candidate of [report(['passed', 'skipped', 'skipped']), report(['passed']), report(undefined, '/source/tests/b.test.ts')]) {
      expect(compareCaseInventories(before, inventory([candidate])).equal).toBe(false)
    }
  })
  it('cannot call two failed runs healthy just because their case lists match', () => {
    const value = { ...report(), success: false, numFailedTestSuites: 1 }
    expect(compareCaseInventories(inventory([value]), inventory([value]))).toMatchObject({ equal: true, healthy: false })
  })
  it('does not treat unfinished cases as legitimate conditional skips', () => {
    const pending = inventory([report(['passed', 'pending'])])
    expect(compareCaseInventories(pending, pending)).toMatchObject({ equal: true, healthy: false })
  })
  it('rejects duplicated shard reports, truncated case totals and wrong source roots', () => {
    expect(() => inventory([report(), report()])).toThrow('more than one report')
    expect(() => inventory([{ ...report(), numTotalTests: 99 }])).toThrow('total mismatch')
    expect(() => inventory([report(undefined, '/another/tests/a.test.ts')])).toThrow('outside source root')
  })
})
