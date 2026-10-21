import { describe, expect, test, vi } from 'vitest'
import {
  buildRosterNameIndex,
  findRosterNameHits,
  resolveOpeningAgentCall,
} from '../../../packages/core/src/shared/rosterNameMatching.mjs'

const roster = [
  { id: 'agent-codex', name: 'Codex 8', type: 'agent' as const },
  { id: 'agent-short', name: '分析', type: 'agent' as const },
  { id: 'human-long', name: '分析结果', type: 'human' as const },
  { id: 'agent-cjk', name: '执行乙', type: 'agent' as const },
  { id: 'agent-ada', name: 'Ada', type: 'agent' as const },
  { id: 'agent-single', name: '甲', type: 'agent' as const },
]

describe('roster-anchored direct name matching', () => {
  const index = buildRosterNameIndex(roster)

  test.each([
    ['Codex 8 帮我看一下', ['agent-codex']],
    ['cOdEx8, please check', ['agent-codex']],
    ['Ｃｏｄｅｘ　８ 帮我看一下', ['agent-codex']],
    ['Codxe 8 帮我看一下', ['agent-codex']],
    ['执行乙你看一下', ['agent-cjk']],
  ])('opening call %s resolves within the closed roster', (content, expected) => {
    expect(resolveOpeningAgentCall(index, content)).toEqual(expected)
  })

  test('later prose mention does not become an address', () => {
    expect(resolveOpeningAgentCall(index, '我刚和 Codex 8 讨论过，继续观察')).toEqual([])
  })

  test('longest roster name claims a CJK short-name prefix even when it is human', () => {
    expect(resolveOpeningAgentCall(index, '分析结果很好，继续保持')).toEqual([])
  })

  test('ASCII boundary, short-name exactness, and single-code-point exclusion fail closed', () => {
    expect(resolveOpeningAgentCall(index, 'Adam should continue')).toEqual([])
    expect(resolveOpeningAgentCall(index, 'Aad should continue')).toEqual([])
    expect(resolveOpeningAgentCall(index, '甲，请看')).toEqual([])
  })

  test('equally plausible roster typos are ambiguous and do not address anyone', () => {
    const ambiguous = buildRosterNameIndex([
      { id: 'agent-mira', name: 'Mira', type: 'agent' },
      { id: 'agent-nira', name: 'Nira', type: 'agent' },
    ])
    expect(resolveOpeningAgentCall(ambiguous, 'Kira please check')).toEqual([])
  })

  test('duplicate display names retain deterministic roster recipients', () => {
    const duplicate = buildRosterNameIndex([
      { id: 'agent-z', name: 'Reviewer', type: 'agent' },
      { id: 'agent-a', name: 'Reviewer', type: 'agent' },
    ])
    expect(resolveOpeningAgentCall(duplicate, 'Reviewer please check')).toEqual(['agent-a', 'agent-z'])
  })

  test('decision path performs no network operation', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network is forbidden in roster matching')
    })
    try {
      for (let sample = 0; sample < 1_000; sample += 1) {
        resolveOpeningAgentCall(index, 'Codex 8 帮我看一下')
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('#2773 outbox matcher keeps NFC, longest-name, CJK, ASCII, and single-code-point rules', () => {
    const directory = roster.map((member) => ({
      id: member.id,
      display_name: member.name,
      type: member.type,
    }))
    expect(findRosterNameHits(directory, '执行乙你看一下')).toEqual([{ name: '执行乙', ids: ['agent-cjk'] }])
    expect(findRosterNameHits(directory, 'Adam should continue')).toEqual([])
    expect(findRosterNameHits(directory, '甲，请看')).toEqual([])
    expect(findRosterNameHits(directory, '分析结果很好')).toEqual([])
  })
})
