import { describe, expect, it } from 'vitest'
import { rankEntityMatches, rankMessage } from './rank'

describe('command-palette ranking transplant', () => {
  const items = ['发布计划', '产品群', 'fabu', 'fabu release', '日常产品', '发布']
  const rank = (query: string) => rankEntityMatches(items, query, (item) => [item])
  it('keeps literal tiers above pinyin and the original order among equal tiers', () => {
    expect(rank('fabu')).toEqual(['fabu', 'fabu release', '发布计划', '发布'])
    expect(rank('产品')).toEqual(['产品群', '日常产品'])
    expect(rank('cp')).toEqual(['产品群', '日常产品'])
    expect(rank('')).toEqual(items)
    expect(rank('  ')).toEqual(items)
  })
  it('retains already-recalled non-name hits without mutating the input', () => {
    const before = [...items]
    expect(rankEntityMatches(items, 'fabu', (item) => [item], { recallOnly: true }))
      .toEqual(['fabu', 'fabu release', '发布计划', '发布', '产品群', '日常产品'])
    expect(items).toEqual(before)
  })
})

describe('explicit message ranking reasons', () => {
  it('uses the approved components and an injected reference time', () => {
    const features = { phraseHit: true, allTermsHit: true, textRelevance: 1, chatAffinity: 1, senderAffinity: 1,
      createdAt: '2026-10-15T00:00:00Z', mentionsActor: true, fromActor: true, isAgent: true, isThreadReply: true }
    const result = rankMessage(features, { now: Date.parse('2026-10-29T00:00:00Z'), sort: 'relevant' })
    expect(result.score).toBe(113)
    expect(result.reasons.reduce((sum, reason) => sum + reason.points, 0)).toBe(result.score)
    expect(rankMessage(features, { now: Date.parse('2026-10-29T00:00:00Z'), sort: 'recent' }).score).toBe(128)
  })
})
