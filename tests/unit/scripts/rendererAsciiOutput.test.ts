// @@@renderer-ascii-output — 渲染层产物转成纯 ASCII 后,每段代码的行为必须与转之前一模一样。
// 判据:同一段表达式,原文与转义后各 eval 一次,结果逐项相等;且转义后不再含非 ASCII 字符。
import { parseAst } from 'vite'
import { describe, expect, it } from 'vitest'
import { escapeNonAscii, taggedTemplateNonAsciiRanges } from '../../../scripts/renderer-chunking.mts'

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
