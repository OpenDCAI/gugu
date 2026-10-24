import { describe, expect, it } from 'vitest'
import { activeMentionPicks, resolveMentionUserIds, type MentionCandidate } from '../../../../apps/desktop/src/lib/mention'
import { buildMentionRender } from '../../../../apps/desktop/src/lib/mentionRenderModel'
import { displayAgentReferences } from '../../../../apps/desktop/src/lib/mentionMdast'
import { chatPreviewText } from '../../../../apps/desktop/src/lib/agentTurnFailure'

const members: MentionCandidate[] = [
  { id: 'member-a', name: 'Agent 2', type: 'agent' },
  { id: 'member-b', name: 'Agent 2', type: 'agent' },
]

describe('task references in chat', () => {
  it('addresses a handwritten member reference by ID, leaving same-named and outside agents alone', () => {
    expect(resolveMentionUserIds('@[Agent 2](aid:member-b)', [], members, true)).toEqual(['member-b'])
    expect(resolveMentionUserIds('@[Agent 2](aid:outside)', [], members, true)).toEqual([])
    expect(resolveMentionUserIds('@[Agent 2](aid:member-b)', [], members, false)).toEqual([])
    expect(resolveMentionUserIds('`@[Agent 2](aid:member-b)`', [], members, true)).toEqual([])
  })

  it('does not keep a deleted selection alive through a same-named outside reference', () => {
    const selected = [{ userId: 'member-a', displayName: 'Agent 2' }]
    expect(activeMentionPicks('@[Agent 2](aid:outside)', selected, members)).toEqual([])
    expect(activeMentionPicks('@[Agent 2](aid:member-a)', selected, members)).toEqual(selected)
  })

  it('renders one backed member mention and only a name for an outside reference', () => {
    const model = buildMentionRender('@[Agent 2](aid:member-b) and @[Private](aid:outside)', ['member-b'], {
      nameOf: () => 'Agent 2', marker: '#ggm-reading',
    })
    expect(model.content).toBe('[@Agent 2](#ggm-reading) and @Private')
    expect(model.fallbackLabels).toEqual([])
    expect(displayAgentReferences('Ask @[Private](aid:outside)')).toBe('Ask @Private')
  })

  it('shows reference names in plain previews while keeping literal code untouched', () => {
    expect(chatPreviewText({
      last_message_preview: 'Ask @[Private\\*task\\*](aid:outside), not `@[Example](aid:literal)`',
      last_message_failure: null,
    })).toBe('Ask @Private*task*, not `@[Example](aid:literal)`')
    expect(chatPreviewText({ last_message_preview: null, last_message_failure: null })).toBe('')
  })
})
