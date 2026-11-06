import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import YAML from 'yaml'
import { browserShardPlan } from '../../../scripts/test-infra/vitest-browser-shard-plan.mjs'

type Step = { id?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> }
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

it('partitions the complete browser project exactly once across two equal CI groups, independent of runner core count', () => {
  const plan = (group: number, cores: number) => browserShardPlan(['--project', 'session-browser', '--shard-group=' + group + '/2', '--shards-per-group=4'], cores)
  const a = plan(1, 4), b = plan(2, 2)
  expect(a.args).toEqual(['--project', 'session-browser'])
  expect([...a.shards, ...b.shards]).toEqual(Array.from({ length: 8 }, (_, i) => ({ index: i + 1, total: 8 })))
  expect(a.total).toBe(4); expect(b.total).toBe(4)
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
it('runs both browser groups on separate CI jobs without enabling unverified browser module caching', () => {
  const job = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs['session-browser']
  expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
  expect(job.name).toBe('Session browser project (${{ matrix.shard }}/2)')
  expect(job.steps.find((step: Step) => step.run?.includes('vitest-browser-shards.mjs')).run)
    .toContain('--shard-group=${{ matrix.shard }}/2 --shards-per-group=4')
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
  for (const group of [1, 2]) {
    const output = execFileSync(process.execPath, [resolve('scripts/test-infra/vitest-browser-shards.mjs'), '--project', 'session-browser', '--shard-group=' + group + '/2', '--shards-per-group=4'], { cwd: root, env, encoding: 'utf8' })
    expect(output).toContain('browser shards: 4/4 passed')
  }
  const traces = readdirSync(join(root, 'trace')).sort()
  expect(traces).toEqual(Array.from({ length: 8 }, (_, i) => (i + 1) + '-8.json'))
  for (const file of traces) expect(JSON.parse(readFileSync(join(root, 'trace', file), 'utf8')))
    .toEqual(['run', '--project', 'session-browser', '--shard=' + file.replace('-8.json', '/8')])
})
it('the real CLI keeps a failed shard fatal for its CI group', () => {
  const { root, env } = browserCliFixture()
  try {
    execFileSync(process.execPath, [resolve('scripts/test-infra/vitest-browser-shards.mjs'), '--project', 'session-browser', '--shard-group=2/2', '--shards-per-group=4'], { cwd: root, env: { ...env, FAIL_SHARD: '7/8' }, encoding: 'utf8' })
    throw new Error('A failed shard must not pass the group')
  } catch (error) {
    expect(error).toMatchObject({ status: 1 })
    expect((error as { stdout: string }).stdout).toContain('failed: 7/8')
  }
})
