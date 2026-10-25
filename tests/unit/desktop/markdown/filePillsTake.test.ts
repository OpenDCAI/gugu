import { describe, expect, it } from 'vitest'
import { filePillText } from '../../../../apps/desktop/src/components/markdown/filePills'
import { markdownMentionReferences } from '@gugu/session-shared/markdown/dialect'

/**
 * Citations use the same mention grammar as the editor and received message.
 * Their labels, location metadata and positions survive without a separate reference row.
 */
const ID = '0c000000-0000-4000-8000-0000000000a1'

describe('inline file citation tokens', () => {
  it('round-trips: brackets and a backslash in the label, Chinese and an angled target with a space', () => {
    const pills = [
      { label: '图 2] · a[b]\\c', link: `gugu-file://${ID}?v=3#slide=2&shape=9` },
      { label: '预算 · 销售!B2:D4', link: `gugu-file://${ID}?v=2#range='2024 预算'!A1:D4` },
      { label: '只有文件', link: `gugu-file://${ID}` },
    ]
    const sent = pills.map(filePillText).join(' 和 ')
    expect(sent).toContain(`(<gugu-file://${ID}?v=2#range='2024 预算'!A1:D4>)`)
    expect(markdownMentionReferences(sent).map(({ label, target }) => ({ label, link: target }))).toEqual(pills)
  })

  it('keeps two positions in the same file mixed with their instructions', () => {
    const a = filePillText({ label: '背景 · 12–14 行', link: `gugu-file://${ID}?v=7#lines=12-14&h=12345678&n=2` })
    const b = filePillText({ label: '工具条 · 49 行', link: `gugu-file://${ID}?v=7#lines=49&h=87654321` })
    const text = `先把 ${a} 改实色。\n${b} 保持原样；再核一下 ${a}。`
    const references = markdownMentionReferences(text)
    expect(references.map(({ start, end }) => text.slice(start, end))).toEqual([a, b, a])
    expect(references.map(({ target }) => target)).toEqual([
      `gugu-file://${ID}?v=7#lines=12-14&h=12345678&n=2`,
      `gugu-file://${ID}?v=7#lines=49&h=87654321`,
      `gugu-file://${ID}?v=7#lines=12-14&h=12345678&n=2`,
    ])
  })
})
