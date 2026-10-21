import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  compareToBaseline,
  countTree,
} from '../../../scripts/console-usage-check.mjs'

const repoRoot = resolve(__dirname, '../../..')
const checker = join(repoRoot, 'scripts/console-usage-check.mjs')
const baselineFile = 'baseline.json'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'gugu-console-usage-'))
  const file = join(directory, 'src', 'source.ts')
  mkdirSync(join(directory, 'src'))
  writeFileSync(file, source)
  git(directory, ['init', '-q', '-b', 'main'])
  git(directory, ['config', 'user.email', 'checker@example.test'])
  git(directory, ['config', 'user.name', 'Console checker'])
  git(directory, ['add', '.'])
  git(directory, ['commit', '-q', '-m', 'fixture'])
  return { directory, file }
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', message])
}

function run(cwd: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [checker, '--root', 'src', '--baseline', baselineFile, ...extra], {
    cwd,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function seedBaseline(directory: string): void {
  const entries = countTree('HEAD', ['src'], directory).entries
  writeFileSync(join(directory, baselineFile), `${JSON.stringify(entries, null, 2)}\n`)
  commit(directory, 'baseline')
}

describe('console usage keyed-debt checker', () => {
  test('counts syntax through the TypeScript AST and excludes comments and strings', () => {
    const repo = fixture(`
      // console.error('comment')
      const text = "console.warn('string')"
      console.log('one')
      console['warn']('two')
      const saved = console.error
    `)
    try {
      expect(countTree('HEAD', ['src'], repo.directory)).toMatchObject({
        total: 3,
        scanned: 1,
        entries: [{ rule: 'console-member', file: 'src/source.ts', count: 3 }],
      })
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('reports NEW and STALE per file instead of hiding equal swaps in one total', () => {
    expect(compareToBaseline(
      [{ rule: 'console-member', file: 'new.ts', count: 1 }],
      [{ rule: 'console-member', file: 'old.ts', count: 1 }],
    )).toEqual({
      added: [{ rule: 'console-member', file: 'new.ts', count: 1, baselineCount: 0 }],
      stale: [{ rule: 'console-member', file: 'old.ts', count: 1, actualCount: 0 }],
    })
  })

  test('the generated baseline passes, while one added call is a positive-control failure', () => {
    const repo = fixture(`console.log('existing')\n`)
    try {
      seedBaseline(repo.directory)
      expect(run(repo.directory).status).toBe(0)
      writeFileSync(repo.file, `console.log('existing')\nconsole.error('new')\n`)
      commit(repo.directory, 'new debt')
      const result = run(repo.directory)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('::error::NEW console-member src/source.ts: baseline=1 actual=2')
      expect(run(repo.directory, ['--write']).stderr).toContain('--write refuses to record NEW console debt')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('--write accepts a pure reduction and removes the stale generated entry', () => {
    const repo = fixture(`console.log('existing')\n`)
    try {
      seedBaseline(repo.directory)
      writeFileSync(repo.file, `export const clean = true\n`)
      commit(repo.directory, 'reduce debt')
      expect(run(repo.directory).stderr).toContain('::error::STALE')
      expect(run(repo.directory, ['--write']).status).toBe(0)
      expect(JSON.parse(readFileSync(join(repo.directory, baselineFile), 'utf8'))).toEqual([])
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })
})
