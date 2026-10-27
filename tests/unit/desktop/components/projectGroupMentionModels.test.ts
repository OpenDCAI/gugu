// OpenDCAI/gugu#446 项目群主线上 @ 不到任务 agent:候选、打出来的 @ 和开头呼语用的是同一份收窄后的名册。
import { describe, expect, it } from 'vitest'
import { buildRosterNameIndex, resolveOpeningAgentCall } from '../../../../packages/core/src/shared/rosterNameMatching.mjs'
import { projectGroupMainLine } from '../../../../apps/desktop/src/components/chat/projectGroupMentionModels'
import { resolveMentionUserIds, type GroupRosterCandidate } from '../../../../apps/desktop/src/lib/mention'

const roster: GroupRosterCandidate[] = [
  { id: 'owner-1', name: '主人', type: 'human' },
  { id: 'agent-task', name: 'Claude 7', type: 'agent' },
  { id: 'agent-guest', name: '咕咕', type: 'agent' },
]

describe('projectGroupMainLine', () => {
  it('outside a project group the roster and @all stay as they are', () => {
    const line = projectGroupMainLine(roster, null)
    expect(line.roster).toBe(roster)
    expect(line.mentionAll).toBe(true)
    expect(line.reachable('agent-task')).toBe(true)
  })

  it('on a project group main line its task agents and @all are out of reach', () => {
    const line = projectGroupMainLine(roster, ['agent-task'])
    expect(line.roster.map((member) => member.id)).toEqual(['owner-1', 'agent-guest'])
    expect(line.mentionAll).toBe(false)
    expect(line.reachable('agent-task')).toBe(false)
    expect(line.reachable('agent-guest')).toBe(true)
  })

  it('a typed @name or an opening call to a task agent addresses nobody', () => {
    const line = projectGroupMainLine(roster, ['agent-task'])
    expect(resolveMentionUserIds('@Claude 7 看一下', [], line.roster, true)).toEqual([])
    expect(resolveOpeningAgentCall(buildRosterNameIndex(line.roster), 'Claude 7，看一下')).toEqual([])
    // The same words outside a project group still reach it.
    expect(resolveMentionUserIds('@Claude 7 看一下', [], roster, true)).toEqual(['agent-task'])
  })
})
