import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { seedCacheDirectory } from '../../../scripts/ci/seed-community-caches.mjs'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-seed-')); roots.push(root)
  const from = join(root, 'legacy'), to = join(root, 'task')
  mkdirSync(join(from, 'v10'), { recursive: true }); writeFileSync(join(from, 'v10', 'package'), 'cached package')
  return { from, to }
}
it('retains warm runner packages across a remote cache miss without writing the source', () => {
  const { from, to } = fixture()
  expect(seedCacheDirectory(from, to)).toBe('seeded')
  expect(readFileSync(join(to, 'v10', 'package'), 'utf8')).toBe('cached package')
  writeFileSync(join(to, 'v10', 'package'), 'new local bytes')
  expect(readFileSync(join(from, 'v10', 'package'), 'utf8')).toBe('cached package')
})
it('does not replace a newer restored entry when merging legacy files', () => {
  const { from, to } = fixture()
  mkdirSync(join(to, 'v10'), { recursive: true }); writeFileSync(join(to, 'v10', 'package'), 'restored')
  expect(seedCacheDirectory(from, to)).toBe('seeded')
  expect(readFileSync(join(to, 'v10', 'package'), 'utf8')).toBe('restored')
})
it('leaves cold installs and an already selected store alone', () => {
  const { from, to } = fixture()
  expect(seedCacheDirectory(null, to)).toBe('absent')
  expect(seedCacheDirectory(join(from, 'missing'), to)).toBe('absent')
  expect(seedCacheDirectory(from, from)).toBe('same-store')
  expect(seedCacheDirectory(from, join(from, 'nested'))).toBe('same-store')
  expect(seedCacheDirectory(join(from, 'v10'), from)).toBe('same-store')
})
it('leaves normal installation available when the optional copy cannot be written', () => {
  const { from, to } = fixture(), warn = vi.fn()
  writeFileSync(to, 'not a directory')
  expect(seedCacheDirectory(from, join(to, 'nested'), { warn })).toBe('unavailable')
  expect(warn).toHaveBeenCalledOnce()
  expect(readFileSync(to, 'utf8')).toBe('not a directory')
  expect(readFileSync(join(from, 'v10', 'package'), 'utf8')).toBe('cached package')
})
it('pre-fills between remote restores and the real frozen install', () => {
  const steps = YAML.parse(readFileSync('.github/actions/setup-community/action.yml', 'utf8')).runs.steps
  const seed = steps.findIndex((step: { run?: string }) => step.run?.includes('seed-community-caches.mjs'))
  const install = steps.findIndex((step: { run?: string }) => step.run?.includes('pnpm install --frozen-lockfile'))
  expect(seed).toBeGreaterThan(steps.findIndex((step: { id?: string }) => step.id === 'electron-cache'))
  expect(seed).toBeLessThan(install)
  expect(steps[seed].env).toEqual({ PNPM_CACHE_HIT: '${{ steps.pnpm-cache.outputs.cache-hit }}', ELECTRON_CACHE_HIT: '${{ steps.electron-cache.outputs.cache-hit }}' })
})
it('does not query pnpm or read a legacy cache after exact remote hits', () => {
  const { from, to } = fixture()
  const output = execFileSync(process.execPath, [resolve('scripts/ci/seed-community-caches.mjs')], {
    encoding: 'utf8', env: { PATH: '', HOME: from, GITHUB_WORKSPACE: to, PNPM_CACHE_HIT: 'true', ELECTRON_CACHE_HIT: 'true' },
  })
  expect(output).toBe('')
  expect(existsSync(to)).toBe(false)
})
