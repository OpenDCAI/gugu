import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import YAML from 'yaml'
import { browserShardPlan } from '../../../scripts/test-infra/vitest-browser-shard-plan.mjs'

type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> }
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const steps = (action: string): Step[] => YAML.parse(readFileSync('.github/actions/' + action + '/action.yml', 'utf8')).runs.steps
function due(step: Step, local: boolean) {
  return Function('return (' + (step.if ?? 'true')
    .replace(/steps\.[\w-]+\.outputs\.local-cache/g, JSON.stringify(String(local)))
    .replace(/steps\.[\w-]+\.outputs\.cache-hit/g, "'false'")
    .replaceAll('inputs.container-image', "''").replaceAll('inputs.save-cache', "'true'")
    .replaceAll('github.event_name', "'push'").replaceAll('github.ref', "'refs/heads/dev'") + ')')() as boolean
}

it.each([
  ['self-hosted', 'macOS', true], ['github-hosted', 'macOS', false],
  ['self-hosted', 'Linux', false], ['github-hosted', 'Linux', false],
] as const)('uses the correct cache and actual frozen install for %s / %s', (environment, os, local) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-')); roots.push(root)
  const pnpm = join(root, 'pnpm'), output = join(root, 'output'), envFile = join(root, 'env'), argsFile = join(root, 'args')
  writeFileSync(pnpm, '#!/bin/sh\nif [ "$3" = --version ]; then echo "Version 1.59.1"; else printf "%s\\n" "$@" > "$PNPM_ARGS_FILE"; fi\n')
  chmodSync(pnpm, 0o755)
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, RUNNER_ENVIRONMENT: environment, RUNNER_OS: os, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: output, GITHUB_ENV: envFile, PNPM_ARGS_FILE: argsFile }
  for (const action of ['setup-community', 'setup-playwright']) {
    writeFileSync(output, ''); writeFileSync(envFile, '')
    const all = steps(action), prepare = all.find(step => step.id === (action === 'setup-community' ? 'cache-paths' : 'playwright'))!
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', prepare.run!], { env })
    expect(readFileSync(output, 'utf8')).toContain('local-cache=' + String(local))
    expect(readFileSync(envFile, 'utf8').includes('.ci-cache/')).toBe(!local)
    const caches = all.filter(step => step.uses?.startsWith('actions/cache'))
    expect(caches.every(step => due(step, local) === !local)).toBe(true)
    if (action === 'setup-community') {
      const install = all.filter(step => step.run?.startsWith('pnpm install') && due(step, local))
      expect(install).toHaveLength(1)
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', install[0].run!], { env })
      expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
        'install', '--frozen-lockfile', '--prefer-offline', ...(!local ? ['--store-dir', join(root, '.ci-cache/pnpm')] : []),
      ])
      const bootstrap = all.find(step => step.run?.includes('seed-community-caches.mjs'))!
      expect(due(bootstrap, local)).toBe(!local)
    }
  }
})

it.each([2, 3, 4])('partitions the complete browser project exactly once across %i CI groups, independent of runner core count', groups => {
  const plans = Array.from({ length: groups }, (_, i) => browserShardPlan(['--project', 'session-browser', '--shard-group=' + (i + 1) + '/' + groups, '--shards-per-group=4'], i + 1))
  for (const plan of plans) { expect(plan.args).toEqual(['--project', 'session-browser']); expect(plan.total).toBe(4) }
  expect(plans.flatMap(plan => plan.shards)).toEqual(Array.from({ length: groups * 4 }, (_, i) => ({ index: i + 1, total: groups * 4 })))
})
it('preserves local automatic sharding and targeted single-process runs', () => {
  expect(browserShardPlan(['--project', 'session-browser'], 4).shards).toHaveLength(4)
  expect(browserShardPlan(['--project', 'session-browser', 'one.test.ts'], 8).shards).toEqual([{ index: 1, total: 1 }])
  expect(browserShardPlan(['--project', 'session-browser'], 32).shards).toHaveLength(16)
})
it.each([
  ['--shard-group=1/2'], ['--shards-per-group=4'], ['--shard-group=0/2', '--shards-per-group=4'],
  ['--shard-group=3/2', '--shards-per-group=4'], ['--shard-group=1/2', '--shards-per-group=9'],
  ['--shard-group=1/2', '--shards-per-group=4', 'one.test.ts'],
  ['--shard-group=1/2', '--shards-per-group=4', '--shard=1/3'],
  ['--shard-group=1/2', '--shard-group=2/2', '--shards-per-group=4'],
])('rejects ambiguous or incomplete browser groups %j', (...args) => {
  expect(() => browserShardPlan(['--project', 'session-browser', ...args], 4)).toThrow()
})
it('runs three browser groups on separate CI jobs without enabling unverified browser module caching', () => {
  const job = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs['session-browser']
  expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } })
  expect(job.name).toBe('Session browser project (${{ matrix.shard }}/3)')
  expect(job.steps.find((step: Step) => step.run?.includes('vitest-browser-shards.mjs')).run)
    .toContain('--shard-group=${{ matrix.shard }}/3 --shards-per-group=4')
  expect(job.env?.GUGU_VITEST_MODULE_CACHE).not.toBe('1')
})

function browserCliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-groups-')); roots.push(root)
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true })
  mkdirSync(join(root, 'trace'))
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "const args = process.argv.slice(2), shard = args.find(arg => arg.startsWith('--shard=')).slice(8)",
    "writeFileSync(process.env.TRACE_DIR + '/' + shard.replace('/', '-') + '.json', JSON.stringify(args))",
    "process.exit(shard === process.env.FAIL_SHARD ? 7 : 0)",
  ].join('\n'))
  return { root, env: { ...process.env, TRACE_DIR: join(root, 'trace') } }
}
it('the real CLI dispatches every global shard once without passing group options to Vitest', () => {
  const { root, env } = browserCliFixture()
  for (const group of [1, 2, 3]) {
    const output = execFileSync(process.execPath, [resolve('scripts/test-infra/vitest-browser-shards.mjs'), '--project', 'session-browser', '--shard-group=' + group + '/3', '--shards-per-group=4'], { cwd: root, env, encoding: 'utf8' })
    expect(output).toContain('browser shards: 4/4 passed')
  }
  const traces = readdirSync(join(root, 'trace')).sort((a, b) => parseInt(a) - parseInt(b))
  expect(traces).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) + '-12.json'))
  for (const file of traces) expect(JSON.parse(readFileSync(join(root, 'trace', file), 'utf8')))
    .toEqual(['run', '--project', 'session-browser', '--shard=' + file.replace('-12.json', '/12')])
})
it('the real CLI keeps a failed shard fatal for its CI group', () => {
  const { root, env } = browserCliFixture()
  try {
    execFileSync(process.execPath, [resolve('scripts/test-infra/vitest-browser-shards.mjs'), '--project', 'session-browser', '--shard-group=3/3', '--shards-per-group=4'], { cwd: root, env: { ...env, FAIL_SHARD: '11/12' }, encoding: 'utf8' })
    throw new Error('A failed shard must not pass the group')
  } catch (error) {
    expect(error).toMatchObject({ status: 1 })
    expect((error as { stdout: string }).stdout).toContain('failed: 11/12')
  }
})

it('fits the full PR plus existing dev background work in the 20-hosted-job budget', () => {
  const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const warm = YAML.parse(readFileSync('.github/workflows/ci-cache.yml', 'utf8'))
  const units = ci.jobs.unit.strategy.matrix.shard
  expect(units).toEqual([1, 2, 3, 4, 5, 6])
  expect(ci.jobs.unit.steps.find((step: Step) => step.run?.includes('vitest run')).run).toContain('--shard=${{ matrix.shard }}/6')
  expect(warm.jobs.unit.strategy.matrix.shard).toEqual(units)
  // Every cache stage runs even after an earlier failure, but never overlaps it.
  expect(warm.jobs.mac.needs).toBe('eslint')
  expect(warm.jobs.mac.if).toBe('always()')
  expect(warm.jobs.unit.needs).toBe('mac')
  expect(warm.jobs.unit.if).toBe('always()')
  expect(warm.jobs.unit.strategy['max-parallel']).toBe(1)
  // Each reusable Mac call uses one hosted route, then at most one hosted fork child.
  const jobs = Object.entries(ci.jobs) as [string, { uses?: string; strategy?: { matrix?: { shard?: number[] } } }][]
  const peak = jobs.filter(([id]) => !['changes', 'gate'].includes(id)).reduce((sum, [, job]) => sum + (job.strategy?.matrix?.shard?.length ?? 1), 0)
  expect(peak).toBe(18)
  expect(peak + 1 /* serial cache producer */ + 1 /* Dev Mac build */).toBeLessThanOrEqual(20)
})


it('only persistent Mac checkouts preserve caches, without changing either immutable route or payload', () => {
  const actionSteps = steps('setup-community')
  const clean = actionSteps.find(step => step.name === 'Clean source while preserving checkout-local dependency caches')!
  expect(clean.if).toBe("runner.environment == 'self-hosted' && runner.os == 'macOS'")
  expect(actionSteps.indexOf(clean)).toBeLessThan(actionSteps.findIndex(step => step.uses === 'pnpm/action-setup@v4'))
  for (const [file, sha, id] of [
    ['ci-mac-build.yml', '499a1ee16cb7650190e8a7869bec59e4f4ee9f22', 'build'],
    ['ci-mac-session.yml', '0970e2e3af61985a54bedd313278f72673ccc493', 'session'],
  ]) {
    const path = '.github/workflows/' + file
    const current = YAML.parse(readFileSync(path, 'utf8'))
    const previous = YAML.parse(execFileSync('git', ['show', sha + ':' + path], { encoding: 'utf8' }))
    const checkout = current.jobs[id].steps.find((step: Step) => step.uses === 'actions/checkout@v4')
    expect(checkout.with.clean).toBe("${{ runner.environment != 'self-hosted' }}")
    delete checkout.with.clean
    expect(current).toEqual(previous)
  }
})

it.each([false, true])('the real cleanup removes stale source but preserves nested dependencies and external files (symlink=%s)', linked => {
  const parent = mkdtempSync(join(tmpdir(), 'checkout-clean-')); roots.push(parent)
  const root = join(parent, 'checkout with spaces'), outside = join(parent, 'outside')
  mkdirSync(root); mkdirSync(outside)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-q'); writeFileSync(join(root, 'tracked.ts'), 'original')
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  // checkout@v4 force-checks out the requested ref even with clean:false.
  writeFileSync(join(root, 'tracked.ts'), 'dirty'); git('checkout', '--force', 'HEAD')
  writeFileSync(join(outside, 'sentinel'), 'outside')
  if (linked) symlinkSync(outside, join(root, 'node_modules'))
  else { mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules/sentinel'), 'dependency') }
  for (const dir of ['packages/a/node_modules', '.ci-cache/pnpm', 'dist', 'not-node_modules']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['packages/a/node_modules/sentinel', '.ci-cache/pnpm/sentinel', 'dist/old.js', 'not-node_modules/old.js', '.env.local', 'obsolete.ts']) writeFileSync(join(root, file), 'content')
  const clean = steps('setup-community').find(step => step.name === 'Clean source while preserving checkout-local dependency caches')!
  execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', clean.run!], { env: { ...process.env, GITHUB_WORKSPACE: root } })
  expect(readFileSync(join(root, 'tracked.ts'), 'utf8')).toBe('original')
  expect(readFileSync(join(root, 'node_modules/sentinel'), 'utf8')).toBe(linked ? 'outside' : 'dependency')
  expect(readFileSync(join(root, 'packages/a/node_modules/sentinel'), 'utf8')).toBe('content')
  expect(readFileSync(join(root, '.ci-cache/pnpm/sentinel'), 'utf8')).toBe('content')
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside')
  for (const file of ['dist', 'not-node_modules', '.env.local', 'obsolete.ts']) expect(readdirSync(root)).not.toContain(file)
  // A misbound nested directory must fail before git clean can affect its parent repo.
  mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'must-stay.ts'), 'sentinel')
  expect(() => execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', clean.run!], { env: { ...process.env, GITHUB_WORKSPACE: join(root, 'nested') }, stdio: 'pipe' })).toThrow()
  expect(readFileSync(join(root, 'must-stay.ts'), 'utf8')).toBe('sentinel')
})
