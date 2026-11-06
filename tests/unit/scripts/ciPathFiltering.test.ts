import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { deriveCheckProfiles, evaluateCheckSnapshots } from '../../../scripts/ci/check-verdict.mts'
import { collectAutomaticRunnerCommands, loadCoverageWorkflowInventory } from '../../../scripts/ci/ci-spec-coverage.mts'

const source = readFileSync('.github/workflows/ci.yml', 'utf8')
const ci = YAML.parse(source)
const entries = [loadCoverageWorkflowInventory(process.cwd()).find(entry => entry.path === '.github/workflows/ci.yml')!]
const reusableWorkflows = Object.fromEntries(Object.values(ci.jobs)
  .filter(job => (job as { uses?: string }).uses)
  .map(job => {
    const use = (job as { uses: string }).uses
    const [path, sha] = use.replace('GUYI-AI/gugu/', '').split('@')
    return [use, { path, source: execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8' }) }]
  }))
const profiles = deriveCheckProfiles([{
  id: 'pr', type: 'pull_request', action: 'synchronize', baseRef: 'dev',
  changedPaths: ['README.md'], inventoryRef: 'fixture',
  workflows: [{ path: '.github/workflows/ci.yml', source, reusableWorkflows }],
}])
const dueTests = ['unit', 'session-db', 'session-browser', 'projection-media', 'web-smoke', 'supabase-contract']
function gate(tests: string, overrides: Record<string, string> = {}) {
  const step = ci.jobs.gate.steps[0].run.replace(/\$\{\{\s*needs\.([\w-]+)\.(result|outputs\.tests)\s*\}\}/g,
    (_: string, id: string, property: string) => property === 'result' ? (overrides[id] ?? 'success') : tests)
  return spawnSync('/bin/bash', ['-e', '-c', step], { env: { PATH: '/usr/bin:/bin' } }).status
}

describe('documentation/mobile filtering with immutable Mac calls', () => {
  it('keeps both Mac calls unconditional with exact pins and original changes inputs', () => {
    for (const [id, key, input, sha] of [
      ['session-db', 'tests', 'tests-required', 'b97314c509105b6b16bf2e3d98e738200f6103b5'],
      ['desktop-build-mac', 'desktop-mac', 'build-required', 'b97314c509105b6b16bf2e3d98e738200f6103b5'],
    ]) {
      expect(ci.jobs[id].if).toBeUndefined()
      expect(ci.jobs[id].uses).toBe(`GUYI-AI/gugu/.github/workflows/${id === 'session-db' ? 'ci-mac-session' : 'ci-mac-build'}.yml@${sha}`)
      expect(ci.jobs[id].with[input]).toBe(`\${{ needs.changes.outputs.${key} }}`)
    }
  })
  it('unconditionally expands matrix jobs while guarding every docs-only step', () => {
    for (const id of ['unit', 'web-smoke']) {
      expect(ci.jobs[id].if).toBeUndefined()
      expect(ci.jobs[id].strategy['fail-fast']).toBe(false)
      for (const step of ci.jobs[id].steps) expect([
        "needs.changes.outputs.tests == 'true'",
        "${{ always() && needs.changes.outputs.tests == 'true' }}",
      ]).toContain(step.if)
    }
  })
  it('rejects a failed/cancelled/skipped required test, including each Mac payload, on source PRs', () => {
    expect(gate('true')).toBe(0)
    for (const id of dueTests) for (const result of ['failure', 'cancelled', 'skipped', '']) {
      expect(gate('true', { [id]: result })).toBe(1)
    }
  })
  it('accepts only success or designed skips for docs, retaining the classifier and policy gates', () => {
    expect(gate('false', Object.fromEntries(dueTests.map(id => [id, 'skipped'])))).toBe(0)
    for (const id of [...dueTests, 'changes', 'policy']) for (const result of ['failure', 'cancelled']) {
      expect(gate('false', { [id]: result })).toBe(1)
    }
    for (const result of ['skipped', '']) for (const id of ['changes', 'policy']) expect(gate('false', { [id]: result })).toBe(1)
    for (const value of ['', 'unknown', 'TRUE']) expect(gate(value)).toBe(1)
  })
  it('validates packaging decisions and every due result, without changing the original hosted build payload', () => {
    const step = ci.jobs.gate.steps[1]
    const base = {
      BUILD_DUE: 'true', DESKTOP_LINUX_DUE: 'true', DESKTOP_MAC_DUE: 'true', ANDROID_DUE: 'true',
      RENDERER_BUILD: 'success', DESKTOP_BUILD_LINUX: 'success', DESKTOP_BUILD_MAC: 'success', ANDROID_BUILD: 'success',
    }
    const run = (env: Record<string, string>) => spawnSync('/bin/bash', ['-e', '-c', step.run], { env: { PATH: '/usr/bin:/bin', ...base, ...env } }).status
    expect(run({})).toBe(0)
    for (const key of ['RENDERER_BUILD', 'DESKTOP_BUILD_LINUX', 'DESKTOP_BUILD_MAC', 'ANDROID_BUILD']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) expect(run({ [key]: result })).toBe(1)
    }
    const notDue = { BUILD_DUE: 'false', DESKTOP_LINUX_DUE: 'false', DESKTOP_MAC_DUE: 'false', ANDROID_DUE: 'false' }
    expect(run({ ...notDue, RENDERER_BUILD: 'skipped', DESKTOP_BUILD_LINUX: 'skipped', ANDROID_BUILD: 'skipped' })).toBe(0)
    for (const key of Object.keys(notDue)) for (const value of ['', 'invalid']) expect(run({ [key]: value })).toBe(1)
    for (const key of ['RENDERER_BUILD', 'DESKTOP_BUILD_LINUX', 'DESKTOP_BUILD_MAC', 'ANDROID_BUILD']) {
      for (const result of ['failure', 'cancelled']) expect(run({ ...notDue, [key]: result })).toBe(1)
    }
  })
  it('requires every registered check, even for docs-only paths', () => {
    const runs = profiles.flatMap(profile => profile.checks).map((name, index) => ({
      id: index, event: 'pull_request', name, status: 'completed', conclusion: 'success',
      outputs: name === 'Detect changed areas' ? { tests: 'false', build: 'false', 'desktop-linux': 'false', 'desktop-mac': 'false', android: 'false' } : undefined,
    }))
    const filtered = profiles[0].pathFiltered ?? {}
    for (const run of runs) if (filtered[run.name]) run.conclusion = 'skipped'
    expect(evaluateCheckSnapshots(profiles, [runs, runs]).verdict).toBe('GREEN')
    for (const name of Object.keys(filtered)) {
      const missing = runs.filter(run => run.name !== name)
      expect(evaluateCheckSnapshots(profiles, [missing, missing]).verdict).toBe('INCOMPLETE')
    }
    const noMarker = runs.map(run => ({ ...run, outputs: undefined }))
    expect(evaluateCheckSnapshots(profiles, [noMarker, noMarker]).verdict).toBe('RED')
  })
  it('collects every source test command through the sole docs guard', () => {
    const commands = collectAutomaticRunnerCommands({ workflows: entries, changedPaths: ['tests/integration/next.test.ts'], packageScripts: {} })
    expect(commands.some(command => command.job === 'session-db/session' && command.args.includes('tooling'))).toBe(true)
    expect(commands.some(command => command.job === 'web-smoke')).toBe(true)
    const units = commands.filter(command => command.job === 'unit')
    expect(units).toHaveLength(6)
    expect(units.map(command => command.args.find(arg => arg.startsWith('--shard='))).sort())
      .toEqual(Array.from({ length: 6 }, (_, i) => `--shard=${i + 1}/6`))
  })
  it.each(['constant-false', 'missing-step', 'wrong-event', 'wrong-checkout', 'wrong-output', 'workflow-bash-env', 'job-bash-env', 'job-container', 'workflow-path', 'workflow-loader', 'job-services', 'job-defaults', 'workflow-defaults'])('rejects %s classifiers in both coverage and canonical', mutation => {
    const entry = structuredClone(entries[0])
    const steps = entry.workflow.jobs.changes.steps
    if (mutation === 'constant-false') steps[1].run = "echo 'tests=false' >> \"$GITHUB_OUTPUT\""
    if (mutation === 'missing-step') steps.pop()
    if (mutation === 'wrong-event') steps[1].env.EVENT_NAME = 'workflow_dispatch'
    if (mutation === 'wrong-checkout') steps[0].with.ref = 'dev'
    if (mutation === 'wrong-output') entry.workflow.jobs.changes.outputs.tests = 'false'
    if (mutation === 'workflow-bash-env') entry.workflow.env.BASH_ENV = '/tmp/hook'
    if (mutation === 'job-bash-env') entry.workflow.jobs.changes.env = { BASH_ENV: '/tmp/hook' }
    if (mutation === 'job-container') entry.workflow.jobs.changes.container = 'attacker/image'
    if (mutation === 'workflow-path') entry.workflow.env.PATH = '/tmp/malicious'
    if (mutation === 'workflow-loader') entry.workflow.env.LD_PRELOAD = '/tmp/hook.so'
    if (mutation === 'job-services') entry.workflow.jobs.changes.services = { hook: { image: 'attacker/image' } }
    if (mutation === 'job-defaults') entry.workflow.jobs.changes.defaults = { run: { shell: 'sh' } }
    if (mutation === 'workflow-defaults') entry.workflow.defaults = { run: { shell: 'sh' } }
    expect(() => collectAutomaticRunnerCommands({ workflows: [entry], changedPaths: ['tests/e2e/ci/new.spec.ts'], packageScripts: {} })).toThrow('condition prevents')
    expect(() => deriveCheckProfiles([{ id: 'pr', type: 'pull_request', action: 'synchronize', baseRef: 'dev', inventoryRef: 'bad', changedPaths: ['tests/e2e/ci/new.spec.ts'], workflows: [{ path: entry.path, source: YAML.stringify(entry.workflow), reusableWorkflows }] }])).toThrow('verified documentation classifier')
  })
  it.each(['literal-false', 'missing-needs'])('rejects %s session input bindings in both inventories', mutation => {
    const entry = structuredClone(entries[0])
    if (mutation === 'literal-false') entry.workflow.jobs['session-db'].with['tests-required'] = 'false'
    else entry.workflow.jobs['session-db'].needs = []
    expect(() => collectAutomaticRunnerCommands({ workflows: [entry], changedPaths: ['tests/integration/new.test.ts'], packageScripts: {} })).toThrow()
    expect(() => deriveCheckProfiles([{
      id: 'pr', type: 'pull_request', action: 'synchronize', baseRef: 'dev', inventoryRef: 'bad',
      changedPaths: ['tests/integration/new.test.ts'],
      workflows: [{ path: entry.path, source: YAML.stringify(entry.workflow), reusableWorkflows }],
    }])).toThrow()
  })
  it('rejects arbitrary guards and missing classifier dependency rather than exempting tests', () => {
    const entry = structuredClone(entries[0])
    for (const condition of ["needs.changes.outputs.android == 'true'", 'false', "github.event_name == 'pull_request'"]) {
      entry.workflow.jobs.unit.if = condition
      expect(() => collectAutomaticRunnerCommands({ workflows: [entry], changedPaths: ['tests/integration/next.test.ts'], packageScripts: {} })).toThrow('condition prevents')
    }
    delete entry.workflow.jobs.unit.if
    entry.workflow.jobs['session-db'].needs = []
    expect(() => collectAutomaticRunnerCommands({ workflows: [entry], changedPaths: ['tests/integration/next.test.ts'], packageScripts: {} })).toThrow('condition prevents')
  })
})
