// #7238: a cited place in a text file of a chat's folder — lines, as a pill names them (`{ lines, h }`), found again once
// the file has changed (workspace/lines.js, pure). Judged here: the fingerprint is FNV-1a over UTF-8; a place reads back;
// relocate keeps the place while its lines read the same, takes the nearest run that does once they moved, and says
// none when no run does.
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { fingerprint, linesText, placeOf, plainWords, relocate, spanOf } from '../../../../apps/desktop/preinstalled-apps/workspace/lines.js'

const doc = ['# 计划', '', '目标：上线', '负责人：小王', '', '## 备注', '目标：上线', '负责人：小王'].join('\n')

describe('a cited place: lines and their fingerprint', () => {
  test('FNV-1a 32 over the UTF-8 bytes, 8 hex digits (the published vectors, and a Chinese line)', () => {
    expect(fingerprint('')).toBe('811c9dc5')
    expect(fingerprint('a')).toBe('e40c292c')
    expect(fingerprint('foobar')).toBe('bf9cf968')
    // Bytes, not UTF-16 units: the same characters always give the same digits on every page.
    expect(fingerprint('目标：上线')).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint('目标：上线')).not.toBe(fingerprint('目标:上线'))
  })

  test('a place names its lines (one line bare), the fingerprint of exactly those lines, and how many read the same', () => {
    // Lines 3–4 have a twin (7–8): n says there were two.
    expect(placeOf(doc, 3, 4)).toEqual({ lines: '3-4', h: fingerprint('目标：上线\n负责人：小王'), n: 2 })
    expect(placeOf(doc, 1, 1)).toEqual({ lines: '1', h: fingerprint('# 计划') })
    expect(linesText(doc, 6, 7)).toBe('## 备注\n目标：上线')
    expect(spanOf('3-4')).toEqual([3, 4])
    expect(spanOf('15')).toEqual([15, 15])
    for (const bad of ['', '0', '4-3', 'a-b', '3-', undefined]) expect(spanOf(bad)).toBeNull()
  })
})

// mac1 A/B 10-15: a pill's words picked in the source were its markdown (`**…**` drawn bold in the pill, a link's syntax
// in its label); picked in the preview, the words a reader sees. The same place reads the same either way.
describe('plainWords: a pill\'s words as a reader sees them', () => {
  test('markers, bold and code marks and a link\'s target go; one line', () => {
    expect(plainWords('- **截止日期**：10 月 30 日（见[排期表](https://example.com/plan)）')).toBe('截止日期：10 月 30 日（见排期表）')
    expect(plainWords('## 周五')).toBe('周五')
    expect(plainWords('> 引用的话\n> 第二行')).toBe('引用的话 第二行')
    expect(plainWords('- [x] 做完了\n1. 第一步 `run()`')).toBe('做完了 第一步 run()')
    expect(plainWords('![图](a.png) 和 ~~删掉的~~')).toBe('图 和 删掉的')
    // What is not markup stays: a name with `_`, a lone `*`, words that only look like a list item mid-line.
    expect(plainWords('file_name 是 a * b，不是 - 列表')).toBe('file_name 是 a * b，不是 - 列表')
  })
})

describe('relocate: the lines a pill named, in the file as it is now', () => {
  const { h } = placeOf(doc, 3, 4)

  test('unchanged: where the pill said', () => {
    expect(relocate(doc, [3, 4], h, 2)).toEqual({ first: 3, last: 4, moved: false })
  })

  test('a line added above: the run that reads the same, nearest to where it was — not its twin further down', () => {
    const now = ['新的一行', doc].join('\n')
    expect(relocate(now, [3, 4], h, 2)).toEqual({ first: 4, last: 5, moved: true })
    // The twin (lines 7–8 of the original) is found by its own place: nearest to where it was.
    expect(relocate(now, [7, 8], h, 2)).toEqual({ first: 8, last: 9, moved: true })
  })

  test('the lines themselves changed: no run reads the same', () => {
    const now = doc.replaceAll('负责人：小王', '负责人：小李')
    expect(relocate(now, [3, 4], h, 2)).toBeNull()
    // Control: a fingerprint of other words is not found either, and a place past the end is no crash.
    expect(relocate(doc, [3, 4], fingerprint('别的字'))).toBeNull()
    expect(relocate('一行', [3, 4], h)).toBeNull()
  })

  // #7238 A/B (mac1, 10-15): the cited line was one of two that read the same; it changed, its twin did not.
  test('a cited twin changed and the other did not: none — not the other twin', () => {
    const lines = doc.split('\n')
    lines[7] = '负责人：小李' // line 8: the second twin changed
    const now = lines.join('\n')
    expect(relocate(now, [7, 8], h, 2)).toBeNull()
    // The twin that did not change is still where it was, and found there.
    expect(relocate(now, [3, 4], h, 2)).toEqual({ first: 3, last: 4, moved: false })
    // Control: not told there were two, the other twin is taken for it — what n is for.
    expect(relocate(now, [7, 8], h)).toEqual({ first: 3, last: 4, moved: true })
  })
})
