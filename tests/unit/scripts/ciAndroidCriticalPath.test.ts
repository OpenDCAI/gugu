import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const read = (file: string) => YAML.parse(readFileSync(file, 'utf8'))
type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> }

describe('Android CI startup costs (#1983)', () => {
  it('changes only the node unit pool, retaining all projects and the six disjoint shards', () => {
    const ci = read('.github/workflows/ci.yml')
    const command = ci.jobs.unit.steps.find((step: Step) => step.run?.includes('vitest run')).run as string
    expect(command).toContain('--project gugu --project session-packages --project session-main --project session-chat-ui --shard=${{ matrix.shard }}/6 --pool=threads')
    expect(ci.jobs.unit.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6])
    expect(ci.jobs['session-browser'].steps.find((step: Step) => step.run?.includes('vitest-browser-shards.mjs')).run)
      .toContain('--shard-group=${{ matrix.shard }}/3 --shards-per-group=4')
    expect(ci.jobs.unit['timeout-minutes']).toBe(30)
    expect(ci.jobs.unit.strategy['fail-fast']).toBe(false)
  })

  it('retains every Android build stage and JVM tests while Source checks validates types', () => {
    const ci = read('.github/workflows/ci.yml')
    const action = read('.github/actions/build-android-ci/action.yml')
    expect(action.runs.steps.map((step: Step) => step.run)).toEqual([
      'pnpm build:mobile-agent', 'pnpm build:renderer:ci', 'node scripts/build/phone-web-dir.mts',
      'pnpm exec cap sync', 'bash scripts/build/android-gradle-build.sh assembleDebug',
    ])
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['build:renderer:ci']).toContain('GUGU_TARGET=web tsx scripts/build/build-electron-app.mts')
    expect(ci.jobs.policy.steps.some((step: Step) => step.run === 'pnpm typecheck')).toBe(true)
    expect(ci.jobs.gate.needs).toContain('policy')
    expect(ci.jobs.gate.needs).toContain('android-build')
    expect(ci.jobs['android-build'].steps.some((step: Step) => step.uses === './.github/actions/build-android-ci')).toBe(true)
    expect(ci.jobs['android-build'].steps.some((step: Step) => step.run === 'bash scripts/build/android-gradle-build.sh testDebugUnitTest')).toBe(true)
  })

  it('seeds the exact Gradle consumer key from dev only, in the single background lane', () => {
    const ci = read('.github/workflows/ci.yml'), warm = read('.github/workflows/ci-cache.yml')
    const java = (job: { steps: Step[] }) => job.steps.find(step => step.uses === 'actions/setup-java@v4')!
    expect(java(warm.jobs.unit).with).toEqual(java(ci.jobs['android-build']).with)
    expect(java(warm.jobs.unit).with!['cache-dependency-path']).toContain('pnpm-lock.yaml')
    expect(warm.on).toEqual({ push: { branches: ['dev'] } })
    expect(ci['cache-mode']).toBe('read')
    expect(warm['cache-mode']).toBe('write')
    expect(Object.keys(warm.jobs).sort()).toEqual(['eslint', 'mac', 'unit'])
    expect(warm.jobs.mac.needs).toBe('eslint')
    expect(warm.jobs.unit.needs).toBe('mac')
    expect(java(warm.jobs.unit).if).toBe('matrix.shard == 1')
    expect(warm.jobs.unit.strategy['max-parallel']).toBe(1)
    expect(warm.jobs.unit.steps.filter((step: Step) => step.if === "matrix.shard == 1 && steps.java.outputs.cache-hit != 'true'").map((step: Step) => step.uses ?? step.run))
      .toEqual(['sudo apt-get update && sudo apt-get install -y --no-install-recommends icu-devtools llvm clang lld', './.github/actions/build-android-ci', 'bash scripts/build/android-gradle-build.sh testDebugUnitTest'])
  })
})
