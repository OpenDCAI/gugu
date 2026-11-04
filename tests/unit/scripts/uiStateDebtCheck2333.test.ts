import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(__dirname, '../../..')
const fixtureRoot = join(repoRoot, 'tests/fixtures/ui-state-debt-check')
const checker = join(repoRoot, 'scripts/checks/ui-state-debt-check.mjs')

// @@@synthetic-fixtures (#2333 计数 / #3079 方向性) — 方向性断言一律跑在**合成**仓上,
// ❌ 不读活基线 scripts/checks/ui-state-debt-baseline.json。
// 理由:那份基线的目标是归零;一旦真归零,读活基线的"不许回头"断言会连同"不许前进"一起变成
// 平凡真 —— 守门的测试恰好在最该守的时刻自动失效。合成 fixture 的债务量由本文件写死,与真实债务无关。

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixtureRepo(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'gugu-ui-state-debt-'))
  cpSync(join(fixtureRoot, name), directory, { recursive: true })
  if (name === 'invalid') {
    renameSync(join(directory, 'apps/desktop/src/bad.ts.fixture'), join(directory, 'apps/desktop/src/bad.ts'))
  }
  git(directory, ['init', '-q', '-b', 'main'])
  git(directory, ['config', 'user.email', 'checker@example.test'])
  git(directory, ['config', 'user.name', 'UI-state checker'])
  git(directory, ['add', '.'])
  git(directory, ['commit', '-q', '-m', 'fixture'])
  return { directory, ref: git(directory, ['rev-parse', 'HEAD']) }
}

function runChecker(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [checker, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const BASELINE = 'baseline.json'
const ARGS = ['--root', 'apps/desktop/src', '--baseline', BASELINE]

/**
 * 把当前树的实际债务写成基线 —— 让「基线 == 现状」成为每个方向性用例的起点。
 *
 * 刻意**不**走 `--write`:那条路径拒绝写入 NEW,而从空基线看现存债务全都是 NEW。
 * 这不是缺陷,正是「基线不能用来接受新债」那条约束 —— 首次落基线因此必须是一次
 * 独立、可见于 diff 的动作,不能由 `--write` 顺手完成。
 */
function seedBaseline(directory: string) {
  const script =
    `import { countTree } from ${JSON.stringify(checker)}\n` +
    `import { writeFileSync } from 'node:fs'\n` +
    `writeFileSync(${JSON.stringify(BASELINE)}, JSON.stringify(countTree('HEAD','apps/desktop/src').entries, null, 2) + '\\n')\n`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    encoding: 'utf8'
  })
  expect(result.status, `seed failed: ${result.stderr}`).toBe(0)
  git(directory, ['add', '-A'])
  git(directory, ['commit', '-q', '-m', 'baseline'])
  return JSON.parse(readFileSync(join(directory, BASELINE), 'utf8')) as Array<Record<string, unknown>>
}

/** 空基线:给「零债务树」与 fail-loud 用例用。 */
function emptyBaseline(directory: string) {
  writeFileSync(join(directory, BASELINE), '[]\n')
}

function commitAll(directory: string, message: string) {
  git(directory, ['add', '-A'])
  git(directory, ['commit', '-q', '-m', message])
}

describe('UI-state debt checker — counting probes (#2333)', () => {
  test('counts AST/CSS counterexamples per file and excludes comments', () => {
    const repo = fixtureRepo('base')
    try {
      const entries = seedBaseline(repo.directory)
      // 注释里的命中不算;每个计数按文件登记而不是汇总成一个数。
      expect(entries).toEqual([
        { counter: 'css-magic-transition', file: 'apps/desktop/src/counterexamples.css', count: 2 },
        { counter: 'imperative-style-hover', file: 'apps/desktop/src/counterexamples.tsx', count: 3 },
        { counter: 'inline-magic-transition', file: 'apps/desktop/src/counterexamples.tsx', count: 3 },
        { counter: 'tailwind-magic-animation', file: 'apps/desktop/src/counterexamples.tsx', count: 3 },
        { counter: 'tailwind-magic-duration', file: 'apps/desktop/src/counterexamples.tsx', count: 3 }
      ])
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('reports every counter plus the scan-surface denominator', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      const result = runChecker(repo.directory, ARGS)
      expect(result.status).toBe(0)
      // 五个计数全部报,不挑;分母同报 —— 只报分子分不清「0 是干净」还是「没扫到」。
      expect(result.stdout).toContain('imperative-style-hover: baseline=3 actual=3')
      expect(result.stdout).toContain('inline-magic-transition: baseline=3 actual=3')
      expect(result.stdout).toContain('css-magic-transition: baseline=2 actual=2')
      expect(result.stdout).toContain('tailwind-magic-duration: baseline=3 actual=3')
      expect(result.stdout).toContain('tailwind-magic-animation: baseline=3 actual=3')
      expect(result.stdout).toContain('scanned: code=1 css=1')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('returns zero for a tree with no matches and an empty baseline', () => {
    const repo = fixtureRepo('zero')
    try {
      emptyBaseline(repo.directory)
      commitAll(repo.directory, 'baseline')
      const result = runChecker(repo.directory, ARGS)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('imperative-style-hover: baseline=0 actual=0')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })
})

describe('UI-state debt checker — bidirectional baseline (#3079)', () => {
  test('NEW: growing debt is red and names the governing rule', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      rmSync(join(repo.directory, 'apps'), { recursive: true, force: true })
      cpSync(join(fixtureRoot, 'head', 'apps'), join(repo.directory, 'apps'), { recursive: true })
      commitAll(repo.directory, 'growth')

      const result = runChecker(repo.directory, ARGS)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('::error::NEW')
      expect(result.stderr).toContain('UI-state debt increased')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  // ── 红对照 1:删文件也判红 ────────────────────────────────────────────────
  // 旧的单向棘轮在这里是绿的 —— 删掉带债务的文件，计数下降，门放行，而且底座跟着降。
  test('STALE: deleting a debt-bearing file is red, and the denominator shrinks', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      rmSync(join(repo.directory, 'apps/desktop/src/counterexamples.tsx'), { force: true })
      commitAll(repo.directory, 'delete the file instead of fixing it')

      const result = runChecker(repo.directory, ARGS)
      expect(result.status, 'deleting debt must not silently pass').toBe(1)
      expect(result.stderr).toContain('::error::STALE')
      expect(result.stderr).toContain('counterexamples.tsx')
      // 分母同步下降 —— 计数降 + 扫描面缩小 = 删掉的,不是改好的。
      expect(result.stdout).toContain('scanned: code=0 css=1')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  // ── 红对照 2:真改好也判红,直到基线被显式调低 ──────────────────────────────
  // 这条容易被忽略,但少了它就分不清这道门是在守债还是在阻止改进:
  // 红的语义是「你动了但没登记」,不是「你不许动」。
  test('STALE: genuinely fixing debt is red until the baseline records it', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      writeFileSync(
        join(repo.directory, 'apps/desktop/src/counterexamples.tsx'),
        'export default function Fixed() {\n  return { classes: "duration-[var(--dur-fast)]" }\n}\n'
      )
      commitAll(repo.directory, 'actually fix it')

      const before = runChecker(repo.directory, ARGS)
      expect(before.status, 'an unrecorded improvement must be red').toBe(1)
      expect(before.stderr).toContain('::error::STALE')
      expect(before.stderr).toContain('--write')

      // 登记之后才绿 —— 改进因此必须出现在 diff 里，可被评审。
      const written = runChecker(repo.directory, [...ARGS, '--write'])
      expect(written.status).toBe(0)
      const after = runChecker(repo.directory, ARGS)
      expect(after.status).toBe(0)
      expect(after.stdout).toContain('imperative-style-hover: baseline=0 actual=0')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  // ── 本次升级的核心:标量基线唯一看不见的形状 ──────────────────────────────
  test('equal swap (fixed here, regrown there) fires BOTH NEW and STALE', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      // 把 tsx 里的三处 imperative-style-hover 挪到另一个文件：总数不变，17→17 形态。
      const source = readFileSync(join(repo.directory, 'apps/desktop/src/counterexamples.tsx'), 'utf8')
      const moved = source
        .replace("event.currentTarget.style.opacity = '0.8'", '')
        .replace(";(event.currentTarget as HTMLElement).style.background = 'red'", '')
        .replace("currentTarget.style.color = 'blue'", '')
      writeFileSync(join(repo.directory, 'apps/desktop/src/counterexamples.tsx'), moved)
      writeFileSync(
        join(repo.directory, 'apps/desktop/src/regrown.tsx'),
        'export default function Regrown(event: { currentTarget: HTMLElement }) {\n' +
          "  event.currentTarget.style.opacity = '0.8'\n" +
          "  event.currentTarget.style.background = 'red'\n" +
          "  event.currentTarget.style.color = 'blue'\n" +
          '  return null\n}\n'
      )
      commitAll(repo.directory, 'equal swap')

      const result = runChecker(repo.directory, ARGS)
      // 总数没变,标量基线在这里恒绿;按 (counter,file) 记条目才看得见。
      expect(result.stdout).toContain('imperative-style-hover: baseline=3 actual=3')
      expect(result.status, 'an equal swap must not pass').toBe(1)
      expect(result.stderr).toContain('::error::NEW')
      expect(result.stderr).toContain('regrown.tsx')
      expect(result.stderr).toContain('::error::STALE')
      expect(result.stderr).toContain('counterexamples.tsx')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  // ── 承重墙:write 路径 ────────────────────────────────────────────────────
  // check 路径的断言守不住这里。一个债务棘轮真正被打败的方式是有人跑一次 `--write`,
  // 让新违规被基线**静默吸收** —— 从那一刻起它不再是违规,而 check 路径的每一条断言
  // 都还是绿的:它们看到的基线已经把新债当成既有事实了。
  //
  // 判据必须是**字节**不变,不是 JSON.parse 后语义相等:后者放过"拒绝了但顺手重写了一半/
  // 重排了顺序"这类半吊子写入 —— 那种文件在语义上等价,却证明 write 路径确实动过盘。
  test('--write refuses to record NEW debt — the gate has no master key', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      const bytesBefore = readFileSync(join(repo.directory, BASELINE))
      rmSync(join(repo.directory, 'apps'), { recursive: true, force: true })
      cpSync(join(fixtureRoot, 'head', 'apps'), join(repo.directory, 'apps'), { recursive: true })
      commitAll(repo.directory, 'growth')

      const written = runChecker(repo.directory, [...ARGS, '--write'])
      expect(written.status, '--write must not launder new debt').toBe(1)
      expect(written.stderr).toContain('refuses to record NEW debt')
      const bytesAfter = readFileSync(join(repo.directory, BASELINE))
      expect(bytesAfter.equals(bytesBefore), 'baseline bytes must be untouched, not merely equivalent').toBe(true)

      // 而且拒绝之后 check 路径依然判红 —— 证明这条新债没有被任何一侧悄悄接受。
      const recheck = runChecker(repo.directory, ARGS)
      expect(recheck.status).toBe(1)
      expect(recheck.stderr).toContain('::error::NEW')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  // 反面:同一条 write 路径在**只有改进**时必须真的落盘 —— 否则"拒绝"是靠瘫痪实现的,
  // 那样 STALE 将永远无法销账,门会从"守债"退化成"禁止任何改动"。
  test('--write does record a pure improvement (the refusal is targeted, not paralysis)', () => {
    const repo = fixtureRepo('base')
    try {
      seedBaseline(repo.directory)
      const bytesBefore = readFileSync(join(repo.directory, BASELINE))
      writeFileSync(join(repo.directory, 'apps/desktop/src/counterexamples.tsx'), 'export default 1\n')
      commitAll(repo.directory, 'fix')

      const written = runChecker(repo.directory, [...ARGS, '--write'])
      expect(written.status).toBe(0)
      expect(readFileSync(join(repo.directory, BASELINE)).equals(bytesBefore)).toBe(false)
      expect(runChecker(repo.directory, ARGS).status).toBe(0)
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })
})

describe('UI-state debt checker — fail-loud (#2333/#3079)', () => {
  test('missing or malformed baseline fails loudly instead of defaulting to empty', () => {
    const repo = fixtureRepo('base')
    try {
      const missing = runChecker(repo.directory, ARGS)
      expect(missing.status).toBe(2)
      expect(missing.stderr).toContain('baseline not found')

      writeFileSync(join(repo.directory, BASELINE), '{}')
      expect(runChecker(repo.directory, ARGS).stderr).toContain('must be a JSON array')

      writeFileSync(join(repo.directory, BASELINE), '[{"counter":"nope","file":"a","count":1}]')
      expect(runChecker(repo.directory, ARGS).stderr).toContain('unknown counter')

      writeFileSync(join(repo.directory, BASELINE), '[{"counter":"imperative-style-hover","file":"a","count":0}]')
      expect(runChecker(repo.directory, ARGS).stderr).toContain('positive integer')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('fails loudly for an invalid ref, root path, and missing root argument', () => {
    const repo = fixtureRepo('base')
    try {
      emptyBaseline(repo.directory)
      commitAll(repo.directory, 'baseline')
      expect(runChecker(repo.directory, [...ARGS, '--ref', 'no-such-ref']).stderr).toContain('git ref not found')
      expect(
        runChecker(repo.directory, ['--root', 'apps/desktop/does-not-exist', '--baseline', BASELINE]).stderr
      ).toContain('git path not found')
      expect(runChecker(repo.directory, ['--baseline', BASELINE]).stderr).toContain('missing required --root')
    } finally {
      rmSync(repo.directory, { recursive: true, force: true })
    }
  })

  test('fails loudly when TypeScript or CSS cannot be parsed', () => {
    for (const [name, needle] of [
      ['invalid', 'TypeScript parse error'],
      ['invalid-css', 'CSS parse error']
    ] as const) {
      const repo = fixtureRepo(name)
      try {
        emptyBaseline(repo.directory)
        commitAll(repo.directory, 'baseline')
        const result = runChecker(repo.directory, ARGS)
        expect(result.status).toBe(2)
        expect(result.stderr).toContain(needle)
      } finally {
        rmSync(repo.directory, { recursive: true, force: true })
      }
    }
  })
})

describe('UI-state debt baseline asset', () => {
  test('the checked-in baseline is valid and non-growing (entries only shrink over time)', () => {
    const baselineFile = join(repoRoot, 'scripts/checks/ui-state-debt-baseline.json')
    expect(existsSync(baselineFile)).toBe(true)
    const entries = JSON.parse(readFileSync(baselineFile, 'utf8')) as Array<{
      counter: string
      file: string
      count: number
    }>
    expect(Array.isArray(entries)).toBe(true)
    for (const entry of entries) {
      expect(entry.count).toBeGreaterThan(0)
      expect(entry.file.startsWith('apps/desktop/src/')).toBe(true)
    }
    // ⚠️ 这里**只**校验基线自身的形状,不断言任何具体数量 —— 数量归零是目标,
    // 把当前数量写进断言等于把债务固化成契约。方向性由上面的合成 fixture 守。
  })
})
