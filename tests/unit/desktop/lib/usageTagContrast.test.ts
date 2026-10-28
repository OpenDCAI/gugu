// 用量页模型标签旁的小圆点(tokens.css「theme batch B」的 --usage-tag-*):非文本对比 WCAG ≥3:1,亮、暗两种主题的
// 内容底色(--bg)上都要看得见 —— 一个在暗底上几乎看不见的点就是错的(统筹 10-28)。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TAG_COLOR_COUNT, stringToColor } from '../../../../apps/desktop/src/lib/usage/table'

const tokens = readFileSync(join(__dirname, '../../../../apps/desktop/src/styles/tokens.css'), 'utf8')

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('usage model tag dots', () => {
  const backgrounds = [...tokens.matchAll(/^\s*--bg:\s*(#[0-9a-fA-F]{6})\b/gm)].map((m) => m[1])
  const tags = [...tokens.matchAll(/^\s*--usage-tag-(\d+):\s*(#[0-9a-fA-F]{6});/gm)].map((m) => ({ slot: Number(m[1]), color: m[2] }))

  it('has one token per hash slot, in order', () => {
    expect(tags.map((tag) => tag.slot)).toEqual(Array.from({ length: TAG_COLOR_COUNT }, (_, i) => i + 1))
    expect(stringToColor('gpt-6-luna')).toMatch(/^var\(--usage-tag-(\d|1[0-2])\)$/)
  })

  it('every slot is at least 3:1 against both theme backgrounds', () => {
    expect(backgrounds, 'dark and light --bg').toHaveLength(2)
    for (const bg of backgrounds) {
      for (const { slot, color } of tags) expect(contrast(color, bg), `tag ${slot} ${color} on ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })
})
