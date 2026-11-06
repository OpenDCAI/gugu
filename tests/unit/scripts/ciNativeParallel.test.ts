import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const { runNativeRebuild } = require('../../../scripts/build/rebuild-native.cjs')
const original = ['-f', '--build-from-source', '--only', 'better-sqlite3,node-pty']
type RebuildSpawn = (command: string, args: string[], options: { env: Record<string, string | undefined> }) => { status: number }

describe('Linux CI native source build concurrency', () => {
  it('keeps the default and non-CI source-build arguments unchanged', () => {
    for (const env of [{}, { GUGU_CI_NATIVE_PARALLEL: '1' }]) {
      const spawn = vi.fn<RebuildSpawn>(() => ({ status: 0 }))
      runNativeRebuild({ platform: 'linux', env, spawn })
      expect(spawn.mock.calls[0][1]).toEqual(original)
    }
  })

  it('retains both forced source builds with a bounded per-module compiler budget', () => {
    const spawn = vi.fn<RebuildSpawn>(() => ({ status: 0 }))
    runNativeRebuild({ platform: 'linux', env: { CI: 'true', GUGU_CI_NATIVE_PARALLEL: '1', GUGU_CI_NATIVE_JOBS: '2' }, spawn, parallelism: 4 })
    expect(spawn.mock.calls[0][1]).toEqual([...original, '--parallel', '--jobs', '2'])
    expect(spawn.mock.calls[0][2].env.CXXFLAGS).toContain('-UV8_DEPRECATION_WARNINGS')
  })

  it('fits smaller runners without exceeding their reported compiler capacity', () => {
    for (const parallelism of [1, 2]) {
      const spawn = vi.fn<RebuildSpawn>(() => ({ status: 0 }))
      runNativeRebuild({ platform: 'linux', env: { CI: 'true', GUGU_CI_NATIVE_PARALLEL: '1' }, spawn, parallelism })
      expect(spawn.mock.calls[0][1]).toEqual([...original, ...(parallelism === 2 ? ['--parallel'] : []), '--jobs', '1'])
    }
  })

  it('rejects an invalid or excessive budget before spawning a compiler', () => {
    for (const jobs of ['0', '3', '1.5', 'bad']) {
      const spawn = vi.fn()
      expect(() => runNativeRebuild({ platform: 'linux', env: { CI: 'true', GUGU_CI_NATIVE_PARALLEL: '1', GUGU_CI_NATIVE_JOBS: jobs }, spawn })).toThrow('must be 1 or 2')
      expect(spawn).not.toHaveBeenCalled()
    }
  })

  it('opts in only on the existing Linux native step and retains ABI verification', () => {
    const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const step = ci.jobs['desktop-build-linux'].steps.find((value: { run?: string }) => value.run === 'pnpm rebuild:native')
    expect(step.env).toEqual({ GUGU_CI_NATIVE_PARALLEL: '1', GUGU_CI_NATIVE_JOBS: '2' })
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['rebuild:native']).toBe('node scripts/build/rebuild-native.cjs && node scripts/build/verify-dev-native.mjs')
    expect(ci.jobs['desktop-build-linux']['timeout-minutes']).toBe(45)
  })
})
