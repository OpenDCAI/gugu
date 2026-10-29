import { describe, expect, it } from 'vitest'
import { segment, segmentQuery } from './segment'
import { highlight } from './highlight'

describe('portable pre-segmentation', () => {
  it('normalizes width, case, traditional Han and accents with the same query/document pipeline', () => {
    expect(segment('發佈計劃 ＡＰＩ Café e\u0301')).toBe('发 布 计 划 api cafe e')
    expect(segmentQuery('發布')).toBe('"发 布"')
    expect(segmentQuery('deplo')).toBe('"deplo"*')
    expect(segmentQuery('發布 deplo')).toBe('"发 布" AND "deplo"*')
    expect(segmentQuery('發布 deplo', true)).toBe('"发 布 deplo"')
  })

  it('keeps one/two-character Han, extensions, kana and Hangul searchable without indexing emoji', () => {
    expect(segment('布𠀀𰀀 カナ 한글 👩‍💻')).toBe('布 𠀀 𰀀 カ ナ 한 글')
    expect(segmentQuery('布')).toBe('"布"')
    expect(segmentQuery('布计')).toBe('"布 计"')
    expect(segmentQuery('👩‍💻')).toBe('')
    expect(segment('發\ufe00佈')).toBe('发 布')
  })

  it('quotes all FTS literals, including operator-shaped user input', () => {
    expect(segmentQuery('OR')).toBe('"or"*')
    expect(segmentQuery('name:"x"')).toBe('"name"* AND "x"*')
  })
})

describe('original text highlights', () => {
  it('preserves UTF-16 grapheme boundaries through width and traditional folding', () => {
    const text = '😀 發佈 ＡＰＩ cafe\u0301'
    const ranges = highlight(text, '发布 api café')
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual(['發佈', 'ＡＰＩ', 'cafe\u0301'])
  })

  it('applies the same separated-term and quoted-phrase rules as the query', () => {
    expect(highlight('release middle plan', 'release-plan')).toEqual([{ start: 0, end: 7 }, { start: 15, end: 19 }])
    expect(highlight('release middle plan', '"release plan"')).toEqual([])
    expect(highlight('发布草稿', '发布 -草稿')).toEqual([{ start: 0, end: 2 }])
  })
})
