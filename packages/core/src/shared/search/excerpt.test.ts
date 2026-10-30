import { expect, it } from 'vitest'
import { searchExcerpt } from './highlight'

it('keeps a far-away match visible without modifying the indexed body', () => {
  const body = '前'.repeat(70_000) + 'needle' + '后'.repeat(200)
  const excerpt = searchExcerpt(body, [{ start: 70_000, end: 70_006 }])
  expect(excerpt.text).toContain('needle')
  expect(excerpt.text.slice(excerpt.highlights[0].start, excerpt.highlights[0].end)).toBe('needle')
  expect(body.length).toBe(70_206)
})
