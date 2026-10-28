import { describe, expect, it } from 'vitest'
import {
  filterMentionCandidates,
  findMentionStart,
  isMentionQueryActive,
  matchText,
  mentionMatchScore,
  normalizeMentionKey,
} from '../../../../apps/desktop/src/lib/mentionMatch'

const roster = [
  { name: 'Claude 2' },
  { name: 'gpt-5.4' },
  { name: '张三丰', alias: '老张' },
  { name: 'Codex', guguNumber: 10086 },
  { name: 'Claude' },
]

const names = (query: string) => filterMentionCandidates(roster, query).map((c) => c.name)

describe('mention matching (3a)', () => {
  it('normalizes away whitespace, punctuation and full-width forms', () => {
    expect(normalizeMentionKey(' Claude 2 ')).toBe('claude2')
    expect(normalizeMentionKey('GPT-5.4')).toBe('gpt54')
    expect(normalizeMentionKey('Ｃｌａｕｄｅ')).toBe('claude')
  })

  it('finds names containing spaces or punctuation however the user types them', () => {
    expect(names('Claude 2')).toEqual(['Claude 2'])
    expect(names('claude2')).toEqual(['Claude 2'])
    expect(names('gpt-5.4')).toEqual(['gpt-5.4'])
    expect(names('gpt5')).toEqual(['gpt-5.4'])
  })

  it('reports the matched characters of the original text, for highlighting', () => {
    expect(matchText('Claude 2', 'claude2')).toEqual({ score: 4, hits: [0, 1, 2, 3, 4, 5, 7] })
    expect(matchText('Ｃｌａｕｄｅ Code', 'code')).toEqual({ score: 2, hits: [7, 8, 9, 10] })
    expect(matchText('Pico🤖', 'pico')).toEqual({ score: 4, hits: [0, 1, 2, 3] })
    expect(matchText('张三丰', 'sf')).toEqual({ score: 1, hits: [1, 2] })
    expect(matchText('张三丰', 'xyz')).toBeNull()
  })

  it('folds per grapheme cluster: decomposed names, case-only variants, astral characters', () => {
    expect(matchText('Café', 'café')).toEqual({ score: 4, hits: [0, 1, 2, 3] })
    expect(matchText('각 팀', '각')).toEqual({ score: 3, hits: [0] })
    expect(matchText('ΟΔΟΣ', 'οδος')).toMatchObject({ score: 4 })
    expect(matchText('𠮷野家', '𠮷')).toEqual({ score: 3, hits: [0] })
  })

  it('matches Chinese names by full pinyin, initials and mixed spelling', () => {
    expect(names('zhangsanfeng')).toEqual(['张三丰'])
    expect(names('zsf')).toEqual(['张三丰'])
    expect(names('zhangs')).toEqual(['张三丰'])
    expect(names('laozhang')).toEqual(['张三丰'])
    expect(names('xyz')).toEqual([])
  })

  it('matches the owner-given alias and the gugu number', () => {
    expect(names('老张')).toEqual(['张三丰'])
    expect(names('10086')).toEqual(['Codex'])
    expect(names('100')).toEqual(['Codex'])
  })

  it('ranks exact > prefix > contains, ties keep roster order', () => {
    expect(names('claude')).toEqual(['Claude', 'Claude 2'])
    expect(names('')).toEqual(roster.map((c) => c.name))
    expect(mentionMatchScore({ name: 'Codex' }, 'dex')).toBeGreaterThan(0)
  })
})

describe('mention popup open/close (3a)', () => {
  it('a space inside a name keeps the popup open', () => {
    const withoutPlainClaude = roster.filter((c) => c.name !== 'Claude')
    expect(isMentionQueryActive('Claude ', withoutPlainClaude)).toBe(true)
    expect(isMentionQueryActive('Claude 2', roster)).toBe(true)
    expect(isMentionQueryActive('gpt 5', roster)).toBe(true)
  })

  it('closes once the name is complete and followed by a space (typed or inserted by picking)', () => {
    expect(isMentionQueryActive('Claude 2 ', roster)).toBe(false)
  })

  it('stays open with no match while it can still be a name, closes once it reads as a sentence', () => {
    expect(isMentionQueryActive('nobody', roster)).toBe(true)
    expect(isMentionQueryActive('Claude 2 please', roster)).toBe(false)
    expect(isMentionQueryActive('nobody,', roster)).toBe(false)
    expect(isMentionQueryActive('a\nb', roster)).toBe(false)
  })

  it('finds the @ that started the mention wherever it is typed (#6819)', () => {
    expect(findMentionStart('hi @Claude 2', 12)).toBe(3)
    expect(findMentionStart('mail a@b.com', 12)).toBe(6)
    expect(isMentionQueryActive('b.com', roster)).toBe(false)
    expect(findMentionStart('@x\nfoo', 6)).toBeNull()
    expect(findMentionStart('你好@张', 4)).toBe(2)
  })
})

describe('pinyin only counts when it lands on Han characters', () => {
  it('does not read the Latin letters of a mixed name as pinyin initials', () => {
    expect(matchText('咕咕内测', 'gg')?.score).toBe(1)
    expect(matchText('设计评审 gugu', 'gg')).toBeNull()
    expect(matchText('gugu dev', 'gg')).toBeNull()
  })
})
