import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const read = (file: string) => YAML.parse(readFileSync(file, 'utf8'))
type Step = { uses?: string; if?: string; with?: Record<string, string>; run?: string }
function runs(step: Step, event: string, ref: string, save = 'true', local = false) {
  const expression = (step.if ?? 'true').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('github.event_name', JSON.stringify(event)).replaceAll('github.ref', JSON.stringify(ref))
    .replaceAll('inputs.save-cache', JSON.stringify(save)).replaceAll('inputs.container-image', "''")
    .replace(/steps\.[\w-]+\.outputs\.cache-hit/g, "'false'")
    .replace(/steps\.[\w-]+\.outputs\.local-cache/g, JSON.stringify(String(local)))
  return Function(`return (${expression})`)() as boolean
}

describe('CI cache sharing from dev (#1840)', () => {
  it.each(['setup-community', 'setup-playwright'])('%s never writes a PR/manual/main cache even when a caller asks to save', action => {
    const steps: Step[] = read(`.github/actions/${action}/action.yml`).runs.steps
    const writers = steps.filter(step => /^actions\/cache(?:\/save)?@/.test(step.uses ?? ''))
    expect(writers.length).toBeGreaterThan(0)
    for (const step of writers) {
      expect(runs(step, 'pull_request', 'refs/pull/123/merge')).toBe(false)
      expect(runs(step, 'workflow_dispatch', 'refs/heads/dev')).toBe(false)
      expect(runs(step, 'push', 'refs/heads/main')).toBe(false)
      expect(runs(step, 'push', 'refs/heads/dev')).toBe(true)
      expect(runs(step, 'push', 'refs/heads/dev', 'false')).toBe(false)
      expect(runs(step, 'push', 'refs/heads/dev', 'true', true)).toBe(false)
    }
    const restorers = steps.filter(step => step.uses === 'actions/cache/restore@v4')
    expect(restorers.length).toBeGreaterThan(0)
    expect(restorers.some(step => runs(step, 'pull_request', 'refs/pull/123/merge'))).toBe(true)
  })

  it('keeps PR ESLint and unit caches read-only and preserves the test commands', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci['cache-mode']).toBe('read')
    expect(read('.github/workflows/ci-dev-linux.yml')['cache-mode']).toBe('read')
    for (const job of ['policy', 'unit']) {
      const steps: Step[] = ci.jobs[job].steps
      const caches = steps.filter(step => step.uses?.startsWith('actions/cache'))
      expect(caches).toHaveLength(1)
      expect(caches[0].uses).toBe('actions/cache/restore@v4')
    }
    expect(ci.jobs.unit.steps.some((step: Step) => step.run?.includes('--shard=${{ matrix.shard }}/6'))).toBe(true)
    expect(ci.jobs.policy.steps.some((step: Step) => step.run === 'pnpm lint:source')).toBe(true)
  })

  it('warms the exact consumer keys from dev without dispatch/PR access or cancellation starvation', () => {
    const warm = read('.github/workflows/ci-cache.yml')
    expect(warm.on).toEqual({ push: { branches: ['dev'] } })
    expect(warm['cache-mode']).toBe('write')
    expect(warm.concurrency['cancel-in-progress']).toBe(false)
    expect(warm.jobs.unit.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6])
    const ci = read('.github/workflows/ci.yml')
    for (const [producer, consumer] of [['eslint', 'policy'], ['unit', 'unit']]) {
      const cache = (warm.jobs[producer].steps as Step[]).find(step => step.uses === 'actions/cache@v4')!
      const restore = (ci.jobs[consumer].steps as Step[]).find(step => step.uses === 'actions/cache/restore@v4')!
      expect(cache.with).toEqual(restore.with)
      expect(runs(cache, 'push', 'refs/heads/dev')).toBe(true)
      expect(runs(cache, 'pull_request', 'refs/pull/123/merge')).toBe(false)
    }
    expect(warm.jobs.mac['runs-on']).toBe('macos-15')
    expect(warm.jobs.mac.steps.filter((step: Step) => step.with?.['save-cache'] === 'true').map((step: Step) => step.uses))
      .toEqual(['./.github/actions/setup-community', './.github/actions/setup-playwright'])
  })

  it('splits the dependency store from Electron downloads and includes runtime compatibility in the store key', () => {
    const steps: Step[] = read('.github/actions/setup-community/action.yml').runs.steps
    const stores = steps.filter(step => step.uses === 'actions/cache/restore@v4')
    expect(stores).toHaveLength(2)
    expect(stores.map(step => step.with!.path)).toEqual([
      '${{ steps.cache-paths.outputs.pnpm-store }}', '${{ steps.cache-paths.outputs.electron }}',
    ])
    expect(stores[0].with!.key).toContain('${{ steps.node.outputs.node-version }}')
    expect(stores[0].with!.key).toContain("hashFiles('pnpm-lock.yaml')")
  })
})
