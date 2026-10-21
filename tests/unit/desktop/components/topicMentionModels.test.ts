import { describe, expect, it } from 'vitest'
import { topicMentionCandidates } from '../../../../apps/desktop/src/components/chat/topicMentionModels'

describe('topicMentionCandidates (3a)', () => {
  const identities = {
    'u-src': { display_name: '来源线的人', type: 'human' as const },
    'a-topic': { display_name: 'Claude 2', type: 'agent' as const, gugu_number: 42 },
    'u-noname': { display_name: ' ', type: 'human' as const },
  }
  const sourceRoster = [{ id: 'u-src', name: '来源线的人', type: 'human' as const }]

  it('a topic participant missing from the source roster is still mentionable', () => {
    const got = topicMentionCandidates(sourceRoster, ['u-src'], ['u-src', 'a-topic'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-src', 'a-topic'])
    expect(got[1]).toMatchObject({ name: 'Claude 2', type: 'agent', guguNumber: 42 })
  })

  it('no duplicates, and members without a resolvable name stay out', () => {
    const got = topicMentionCandidates(sourceRoster, ['u-src', 'a-topic'], ['a-topic', 'u-noname', 'ghost'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-src', 'a-topic'])
  })
})
