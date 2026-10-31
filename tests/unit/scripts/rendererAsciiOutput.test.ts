// @@@renderer-ascii-output — 渲染层产物转成纯 ASCII 后,每段代码的行为必须与转之前一模一样。
// 判据:同一段表达式,原文与转义后各 eval 一次,结果逐项相等;且转义后不再含非 ASCII 字符。
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAst } from 'vite'
import { describe, expect, it } from 'vitest'
import { escapeNonAscii, taggedTemplateNonAsciiRanges } from '../../../scripts/build/renderer-chunking.mts'

const run = (code: string): unknown => new Function(`return (${code})`)()
// 与插件同一条路径:rollup 的解析器给区间,区间外全部转义
const escapeChunk = (code: string): string => escapeNonAscii(code, taggedTemplateNonAsciiRanges(parseAst(code)))

const CASES: Array<[string, string]> = [
  ['string literal', `"离线 · 校验失败"`],
  ['regex without u', `[/离线|not connected/.test("已离线"), /[îïíì]/.test("ï"), /[，。！？]/.test("好。")]`],
  ['regex with u', `[/\\p{Script=Han}+/u.test("中文"), /^[₀-₉]+$/u.test("₁₂")]`],
  ['identity escape before non-ASCII', `[/\\ü/.test("ü"), "\\ü"]`],
  ['astral char (surrogate pair)', `["😀".length, /😀/.test("a😀b"), /^.$/u.test("😀")]`],
  ['template literal', "`— ${1 + 1} —`"],
  ['comment', `/* 注释 · license */ 42`],
]

describe('escapeNonAscii', () => {
  for (const [name, code] of CASES) {
    it(`keeps behavior: ${name}`, () => {
      const escaped = escapeNonAscii(code)
      expect(escaped).not.toMatch(/[\u0080-￿]/)
      expect(run(escaped)).toEqual(run(code))
    })
  }

  it('control: a naive escape that keeps the identity-escape backslash changes behavior', () => {
    // `\ü` naively becomes `\\u00fc` — a literal backslash followed by "u00fc". Proves the case above is live.
    const naive = `/\\ü/`.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    expect(run(`${naive}.test("ü")`)).toBe(false)
  })
})

// 带标签模板的 raw 就是值:String.raw`中` 取到的是源码原文,转成 中 就成了六个 ASCII 字符。
const TAGGED: Array<[string, string]> = [
  ['String.raw', 'String.raw`中文`'],
  ['non-ASCII before the tag (ranges are string indices, not bytes)', '["é😀", String.raw`中\\n文`, "ü"]'],
  ['custom tag reading strings.raw', '((s) => s.raw.join("|"))`甲${1}乙`'],
  ['expression inside a tagged template is still escaped', 'String.raw`a${"中"}b`'],
]

describe('escapeNonAscii keeps tagged-template raw text', () => {
  for (const [name, code] of TAGGED) {
    it(`keeps behavior: ${name}`, () => {
      expect(run(escapeChunk(code))).toEqual(run(code))
    })
  }

  it('escapes everything outside the kept raw text', () => {
    expect(escapeChunk('["中", String.raw`文`, String.raw`a${"字"}b`]')).toBe('["\\u4e2d", String.raw`文`, String.raw`a${"\\u5b57"}b`]')
  })

  it('control: without the kept ranges String.raw changes value', () => {
    expect(run(escapeNonAscii('String.raw`中`'))).toBe('\\u4e2d')
    expect(taggedTemplateNonAsciiRanges(parseAst('String.raw`ascii`; `中`'))).toEqual([])
  })
})

// 主进程图(Electron 主进程、worker、helper 运行时与无头宿主共用 sessionMainVite)也只出 ASCII:V8 在每个进程里
// 常驻每个模块的源码,一个非 Latin-1 字符就让整份按双字节存(10-27 Linux 2:主进程堆 89 → 76.5 MB)。
describe('vite.config.mts 的主进程图也挂着 ASCII 输出', () => {
  it('Electron 主进程入口与每个无头宿主入口:esbuild charset=ascii + gugu-renderer-ascii-output', () => {
    const repoRoot = join(import.meta.dirname, '../../..')
    const code = `
      const has = (plugins) => [plugins ?? []].flat(Infinity).some((p) => p && typeof p === 'object' && p.name === 'gugu-renderer-ascii-output')
      const ascii = (vite) => vite?.esbuild?.charset === 'ascii' && has(vite?.plugins)
      const m = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'vite.config.mts')).href)})
      process.stdout.write('READING ' + JSON.stringify({
        main: m.electronBuildEntries.filter((e) => [e.entry].flat().some((x) => String(Object.values(x ?? {}).join() || x).includes('main.ts'))).map((e) => ascii(e.vite)),
        host: m.sessionHostBuildEntries.map((e) => ascii(e.vite)),
      }))`
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: repoRoot, encoding: 'utf8', env: process.env })
    const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('READING '))
    expect(line, `${run.stdout}${run.stderr}`).toBeTruthy()
    const reading = JSON.parse(line!.slice('READING '.length)) as { main: boolean[]; host: boolean[] }
    expect(reading.main.length).toBeGreaterThanOrEqual(1)
    expect(reading).toEqual({ main: reading.main.map(() => true), host: reading.host.map(() => true) })
  }, 120_000)
})
