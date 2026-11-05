import { describe, expect, it } from 'vitest'
import { inheritedJobSource, type WorkflowJob } from '../../../scripts/ci/inherited-job-source.mts'

const original: WorkflowJob = {
  run_id: 40132256047, run_attempt: 1,
  check_run_url: 'https://api.github.com/repos/OpenDCAI/gugu/check-runs/120986290493',
  name: 'Detect changed areas', status: 'completed', conclusion: 'success',
  started_at: '2026-10-24T21:00:00Z', completed_at: '2026-10-24T21:00:05Z',
  steps: [{ number: 3, name: 'Run build=true', status: 'completed', conclusion: 'success',
    started_at: '2026-10-24T21:00:03Z', completed_at: '2026-10-24T21:00:03Z' }],
}
const inherited: WorkflowJob = {
  ...original, run_attempt: 2,
  check_run_url: 'https://api.github.com/repos/OpenDCAI/gugu/check-runs/120988760823',
}
const find = (jobs: WorkflowJob[]) => inheritedJobSource(120988760823, original.run_id, jobs)

describe('inherited Actions job execution identity (#288)', () => {
  it('resolves the original check of an unexecuted job copied to a partial rerun', () => {
    expect(find([inherited, original])).toBe(120986290493)
  })

  it.each([
    { run_id: original.run_id + 1 },
    { run_attempt: 2 },
    { name: 'Other job' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { started_at: '2026-10-24T22:00:00Z' },
    { completed_at: '2026-10-24T22:00:05Z' },
    { steps: [{ ...original.steps![0], name: 'A different command' }] },
    { steps: [{ ...original.steps![0], completed_at: '2026-10-24T21:00:04Z' }] },
    { check_run_url: 'https://api.github.com/repos/other/repo/check-runs/120986290493' },
  ])('rejects a different execution: %j', (change) => {
    expect(find([inherited, { ...original, ...change }])).toBeUndefined()
  })

  it.each([
    { steps: undefined }, { steps: [] }, { started_at: null }, { completed_at: null },
    { started_at: 'invalid' }, { run_attempt: 0 },
    { steps: [{ ...original.steps![0], completed_at: null }] },
  ])('does not infer inheritance from missing execution evidence: %j', (change) => {
    expect(find([{ ...inherited, ...change }, { ...original, ...change }])).toBeUndefined()
  })

  it('rejects a missing or ambiguous check or original execution', () => {
    expect(find([original])).toBeUndefined()
    expect(find([original, inherited, inherited])).toBeUndefined()
    expect(find([original, inherited, { ...original, check_run_url: original.check_run_url.replace('120986290493', '120986290494') }])).toBeUndefined()
  })

  it('follows copies of a later genuine rerun to that rerun, rather than the first workflow attempt', () => {
    const rerun = { ...original, run_attempt: 2, started_at: '2026-10-24T22:00:00Z', completed_at: '2026-10-24T22:00:05Z',
      check_run_url: original.check_run_url.replace('120986290493', '120986290494') }
    expect(find([original, rerun, { ...inherited, run_attempt: 3, started_at: rerun.started_at, completed_at: rerun.completed_at }])).toBe(120986290494)
    expect(find([original, inherited, { ...original, run_attempt: 0 }])).toBe(120986290493)
  })
})
