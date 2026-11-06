import { describe, expect, it, vi } from 'vitest'
import type { TestModule } from 'vitest/node'
import { caseInventory, compareCaseInventories } from '../../../scripts/ci/compare-vitest-cases.mjs'
import CliWorkerAttributionReporter from '../../../scripts/test-infra/vitest-worker-attribution-reporter'

const report = (statuses = ['passed', 'skipped', 'passed'], file = '/source/tests/a.test.ts') => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: statuses.length,
  testResults: [{ name: file, status: 'passed', assertionResults: statuses.map(status => ({ fullName: 'suite > parameter', status })) }],
})
const inventory = (value: ReturnType<typeof report>[]) => caseInventory(value, '/source')

describe('full CI case inventory', () => {
  it('keeps the heartbeat writer callable when Vitest supplies CLI reporter options', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const reporter = Reflect.construct(CliWorkerAttributionReporter, [{}]) as CliWorkerAttributionReporter
      reporter.onTestRunStart([])
      reporter.onTestModuleQueued({ id: 'fixture', moduleId: 'fixture.test.ts' } as TestModule)
      reporter.onTestRunEnd([], [], 'passed')
      expect(write).toHaveBeenCalledWith(expect.stringContaining('fixture.test.ts'))
    } finally { write.mockRestore() }
  })
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
  it('separates repaired failures from identity/skip preservation, without accepting an invalid baseline', () => {
    const failed = { ...report(['failed', 'skipped', 'passed']), success: false, numFailedTests: 1 }
    expect(compareCaseInventories(inventory([failed]), inventory([report()]))).toMatchObject({
      sameCases: true, sameSkips: true, equal: false, healthy: false,
    })
  })
  it('does not treat unfinished cases as legitimate conditional skips', () => {
    const pending = inventory([report(['passed', 'pending'])])
    expect(compareCaseInventories(pending, pending)).toMatchObject({ equal: true, healthy: false })
  })
  it('rejects duplicated shard reports, truncated case totals and wrong source roots', () => {
    expect(() => inventory([report(), report()])).toThrow('more than one report')
    expect(() => inventory([{ ...report(), numTotalTests: 99 }])).toThrow('total mismatch')
    expect(() => inventory([{ ...report(), numTotalTests: 0, testResults: [] }])).toThrow('Empty shard report')
    expect(() => inventory([report(undefined, '/another/tests/a.test.ts')])).toThrow('outside source root')
  })
})
