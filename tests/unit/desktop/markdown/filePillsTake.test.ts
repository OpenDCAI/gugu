import { describe, expect, it } from 'vitest'
import { addFilePills, filePillText, takeFilePills, withFilePills } from '../../../../apps/desktop/src/components/markdown/filePills'

/**
 * App 引用 pill: one way a pill is written (`filePillText`, stringifyMention's @file form) and read back out of words
 * (`takeFilePills`) — the composer's row, a paste, a failed send. Only pills pointing at a group's file are taken.
 */
const ID = '0c000000-0000-4000-8000-0000000000a1'

describe('a pill written, and taken back out of words', () => {
  it('round-trips: brackets and a backslash in the label, Chinese and an angled target with a space', () => {
    const pills = [
      { label: '图 2] · a[b]\\c', link: `gugu-file://${ID}?v=3#slide=2&shape=9` },
      { label: '预算 · 销售!B2:D4', link: `gugu-file://${ID}?v=2#range='2024 预算'!A1:D4` },
      { label: '只有文件', link: `gugu-file://${ID}` },
    ]
    const sent = withFilePills('改这几处', pills)
    expect(sent.startsWith('改这几处\n\n@[')).toBe(true)
    expect(sent).toContain(`(<gugu-file://${ID}?v=2#range='2024 预算'!A1:D4>)`)
    expect(takeFilePills(sent)).toEqual({ text: '改这几处', pills })
  })

  it('takes only group files: other @[…](…), plain links and bare @names stay as written', () => {
    const words = `问 @[Claude 1](aid:abc) 看 [文件](gugu-file://${ID}) @小明`
    expect(takeFilePills(words)).toEqual({ text: words, pills: [] })
  })

  it('tidies where a pill was — no double space, no blank run — and nothing else when there was none', () => {
    const token = filePillText({ label: 'x', link: `gugu-file://${ID}?v=1` })
    expect(takeFilePills(`前 ${token} 后`).text).toBe('前 后')
    expect(takeFilePills(`第一行\n\n${token}\n\n\n第二行`).text).toBe('第一行\n\n第二行')
    // Control: words without a pill come back untouched, spaces and all.
    expect(takeFilePills('a  b \n').text).toBe('a  b \n')
  })

  it('words alone, pills alone', () => {
    expect(withFilePills('只有话', [])).toBe('只有话')
    expect(withFilePills('', [{ label: 'x', link: `gugu-file://${ID}` }])).toBe(`@[x](gugu-file://${ID})`)
  })

  it('addFilePills: one per link, the held ones first and where they were', () => {
    const a = { label: 'a', link: `gugu-file://${ID}?v=1#k=1` }
    const b = { label: 'b', link: `gugu-file://${ID}?v=1#k=2` }
    expect(addFilePills([a], [b, a, b])).toEqual([a, b])
    expect(addFilePills([], [])).toEqual([])
  })
})
