import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const repoRoot = resolve(__dirname, '../../..')
const playwrightCli = join(repoRoot, 'node_modules/playwright/cli.js')
const reporterPath = join(repoRoot, 'scripts/playwright-collection-guard.mts')
let fixtureRoot: string
let configPath: string

function runPlaywright(...args: string[]) {
  return spawnSync(process.execPath, [playwrightCli, 'test', '--config', configPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
}

describe('Playwright collection guard', () => {
  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(repoRoot, '.playwright-collection-guard-'))
    const testsDir = join(fixtureRoot, 'tests')
    mkdirSync(testsDir)
    configPath = join(fixtureRoot, 'playwright.config.ts')
    writeFileSync(configPath, `
      import { defineConfig } from '@playwright/test'
      export default defineConfig({
        testDir: './tests',
        workers: 1,
        retries: 0,
        reporter: [[${JSON.stringify(reporterPath)}], ['list']],
      })
    `)
    writeFileSync(join(testsDir, 'guard.spec.ts'), `
      import { expect, test } from '@playwright/test'
      test('passing control', () => {})
      test('failing control', () => expect(1).toBe(2))
    `)
  })

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  test('turns an empty shard into an explicit failure', () => {
    const run = runPlaywright('--list', '--grep=passing control', '--shard=9/9')
    const output = `${run.stdout}${run.stderr}`

    expect(output).toContain('Total: 0 tests in 0 files')
    expect(output).toContain('收集到 0 条用例')
    expect(run.status, output).not.toBe(0)
  })

  test('keeps a passing test green', () => {
    const run = runPlaywright('--grep=passing control')
    const output = `${run.stdout}${run.stderr}`

    expect(output).toMatch(/1 passed/)
    expect(run.status, output).toBe(0)
  })

  test('keeps a failing test red', () => {
    const run = runPlaywright('--grep=failing control')
    const output = `${run.stdout}${run.stderr}`

    expect(output).toMatch(/1 failed/)
    expect(run.status, output).not.toBe(0)
  })

  test('keeps a non-empty shard green', () => {
    const run = runPlaywright('--grep=passing control', '--shard=1/9')
    const output = `${run.stdout}${run.stderr}`

    expect(output).toMatch(/1 passed/)
    expect(output).not.toContain('收集到 0 条用例')
    expect(run.status, output).toBe(0)
  })

  test('canonical config installs the guard', () => {
    const config = readFileSync(join(repoRoot, 'playwright.config.mts'), 'utf8')
    expect(config).toContain("['./scripts/playwright-collection-guard.mts']")
  })
})
