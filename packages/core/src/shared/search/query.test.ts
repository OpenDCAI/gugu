import { describe, expect, it } from 'vitest'
import { parseQuery, parseSearchTerms, SearchQueryError } from './query'

const now = new Date(2026, 9, 29, 12)
const context = {
  now,
  resolveIn: (value: string) => value === '产品群' ? [{ kind: 'chat' as const, id: 'group', includeTopics: true }] : [],
  resolveFrom: (value: string) => value === '王蕾' ? ['member'] : [],
}

describe('one shared query parser', () => {
  it('resolves filter IDs while retaining the text grammar and navigation origin', () => {
    expect(parseQuery('in:产品群 from:王蕾 has:file has:link is:mention is:whisper "发布 计划" -草稿', {
      ...context, origin: { chatId: 'origin' },
    })).toEqual({
      text: '"发布 计划" -草稿',
      filters: { in: [{ kind: 'chat', id: 'group', includeTopics: true }], from: ['member'], has: ['file', 'link'], is: ['mention', 'whisper'] },
      sort: 'recent', origin: { chatId: 'origin' },
    })
  })

  it('supports quoted names, full-width text, escaped quotes and literal URLs', () => {
    expect(parseQuery('in:"产品群" ＡＰＩ https://example.invalid', context).text).toBe('ＡＰＩ https://example.invalid')
    expect(parseSearchTerms('"from:peer" -"old draft" "a\\"b"')).toEqual([
      { text: 'from:peer', phrase: true, exclude: false },
      { text: 'old draft', phrase: true, exclude: true },
      { text: 'a"b', phrase: true, exclude: false },
    ])
  })

  it('normalizes Chinese and absolute dates without reading the current clock', () => {
    expect(parseQuery('昨天 发布', context).filters).toEqual({ on: '2026-10-28' })
    expect(parseQuery('on:上周', context).filters).toEqual({ after: '2026-10-19', before: '2026-10-26' })
    expect(parseQuery('after:10月1日 before:2026-11-01', context).filters).toEqual({ after: '2026-10-01', before: '2026-11-01' })
    expect(parseQuery('has:image on:2024-02-29', context).filters.on).toBe('2024-02-29')
  })

  it.each(['in:', 'in:unknown', 'from:unknown', 'has:video', 'is:unknown', 'on:2026-02-30', 'on:2026-13-01', 'on:nope', 'frmo:peer', '"open', '-', '-has:file'])(
    'reports malformed input rather than widening the query: %s', (input) => {
      expect(() => parseQuery(input, context)).toThrow(SearchQueryError)
      let failure: unknown
      try { parseQuery(`发布 😀 ${input}`, context) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(SearchQueryError)
      expect(failure).toMatchObject({ position: 6 })
    })

  it('rejects ambiguous entity resolution and leaves supplied filters unmodified', () => {
    expect(() => parseQuery('from:peer', { ...context, resolveFrom: () => ['a', 'b'] })).toThrow(/unambiguous/)
    const filters = { from: ['owner'] }
    expect(parseQuery('from:王蕾', { ...context, filters }).filters.from).toEqual(['owner', 'member'])
    expect(filters).toEqual({ from: ['owner'] })
  })
})
