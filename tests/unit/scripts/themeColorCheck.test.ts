import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const checker = resolve(__dirname, '../../../scripts/theme-color-check.mjs')

// 合成仓,❌ 读活基线:活基线的目标是归零,读它的断言会在债务清空那天变成平凡真。
function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repo(files: Record<string, string>, baseline: unknown[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'gugu-theme-color-'))
  git(directory, ['init', '-q', '-b', 'main'])
  git(directory, ['config', 'user.email', 'checker@example.test'])
  git(directory, ['config', 'user.name', 'Theme checker'])
  commit(directory, files)
  writeFileSync(join(directory, 'baseline.json'), JSON.stringify(baseline))
  return directory
}

function commit(directory: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), text)
  }
  git(directory, ['add', '.'])
  git(directory, ['commit', '-q', '-m', 'change'])
}

function check(directory: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [checker, '--root', 'src', '--baseline', 'baseline.json', ...extra], { cwd: directory, encoding: 'utf8' })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

const TOKENS = 'src/styles/tokens.css'

describe('theme-color-check', () => {
  test('counts hard-coded colors per file, ignoring comments, issue numbers and the token definitions', () => {
    const directory = repo({
      [TOKENS]: ':root { --fg: #dfdfdf; --danger: #ef4444; }',
      'src/card.css': [
        '/* #fff in a comment, and see #7333 */',
        '.card { color: #fff; background: rgba(0, 0, 0, .4); border-color: var(--fg); }',
      ].join('\n'),
      'src/Card.tsx': "export const a = <div className=\"bg-white text-[var(--fg)]\" style={{ stroke: '#000' }} /> // #123abc in a comment",
    })
    const out = check(directory)
    expect(out.status).toBe(1)
    expect(out.out.match(/NEW .*/g)).toEqual([
      'NEW hard-coded-color src/card.css: baseline=0 actual=2',
      'NEW hard-coded-color src/Card.tsx: baseline=0 actual=2',
    ])
    expect(out.out).toContain('hard-coded-color: baseline=0 actual=4')
  })

  test('a new hard-coded color is NEW; --write refuses it; removing one is STALE until recorded', () => {
    const directory = repo({ [TOKENS]: ':root { --fg: #dfdfdf; }', 'src/a.css': '.a { color: var(--fg); }' })
    expect(check(directory).status).toBe(0)
    commit(directory, { 'src/a.css': '.a { color: #ffffff; }' })
    const added = check(directory)
    expect(added.status).toBe(1)
    expect(added.out).toContain('NEW hard-coded-color src/a.css: baseline=0 actual=1')
    expect(check(directory, ['--write']).status).toBe(1)

    writeFileSync(join(directory, 'baseline.json'), JSON.stringify([{ rule: 'hard-coded-color', file: 'src/a.css', count: 1 }]))
    expect(check(directory).status).toBe(0)
    commit(directory, { 'src/a.css': '.a { color: var(--fg); }' })
    const stale = check(directory)
    expect(stale.status).toBe(1)
    expect(stale.out).toContain('STALE hard-coded-color src/a.css: baseline=1 actual=0')
    expect(check(directory, ['--write']).status).toBe(0)
    expect(check(directory).status).toBe(0)
  })

  test('var() to a variable nobody defines is NEW; defined, runtime-provided and --em- generated ones are fine', () => {
    const directory = repo({
      [TOKENS]: ':root { --danger: #ef4444; --spacing-md: 8px; }',
      'src/ok.css': '.ok { color: var(--danger); width: var(--anchor-width); padding: var(--em-spacing-md); }',
      'src/Slot.tsx': "export const s = <div style={{ '--tint': 'red' } as never} className=\"[color:var(--tint)]\" />",
    })
    const clean = check(directory)
    expect(clean.status).toBe(0)
    expect(clean.out).toContain('undefined-var: baseline=0 actual=0')

    commit(directory, { 'src/bad.css': '.bad { color: var(--danger-fg, red); }' })
    const out = check(directory)
    expect(out.status).toBe(1)
    expect(out.out).toContain('NEW undefined-var src/bad.css: baseline=0 actual=1')
    expect(out.out).toContain('undefined: --danger-fg (src/bad.css)')
  })
})
