// @vitest-environment jsdom
//
// 从话题分栏点开的成员名片,倾听模式读写的是**话题自己**那行 chat_members,❌ 不是来源群的
// (2026-09-24 设计同事 截图:「主被动居然是群的而不是 topic 的」)。
// 判据都带反例:主线点开的名片必须原样走群那一套,否则「一律用话题」也能过。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupAgentItem, GroupCollabSnapshot, GroupMemberItem } from '../../../packages/core/src/shared/types/chat'
import type { MemberProfileCardModel } from '../../../apps/desktop/src/components/MemberProfileCard'
import type { ActiveMemberProfile } from '../../../apps/desktop/src/components/memberProfileModels'
import { createNode, createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: { getGroupCollab: vi.fn(), setAgentListenMode: vi.fn(async () => {}) },
}))

const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { useTopicScopedMemberProfile } = await import('../../../apps/desktop/src/hooks/useTopicScopedMemberProfile')
const getGroupCollab = vi.mocked(chatService.getGroupCollab)
const setAgentListenMode = vi.mocked(chatService.setAgentListenMode)

function agentItem(id: string, listen_mode: GroupAgentItem['listen_mode']): GroupAgentItem {
  return {
    id, role: 'member', type: 'agent', account_status: 'active', client: null, model_source: null, tools: [],
    permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null,
    listen_mode,
  }
}
const humanItem = (id: string, role: GroupMemberItem['role']): GroupMemberItem => ({ id, role, type: 'human', account_status: null })
const collab = (agents: GroupAgentItem[], humans: GroupMemberItem[]): GroupCollabSnapshot => ({
  scheduler: { chat_id: 'topic-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-24T00:00:00.000Z' },
  humans, agents, tasks: [], outputs: [],
})

// 群名册里 a1 是「主动」—— 这正是名片过去在话题里显示的那个数。
const groupMember: MemberProfileCardModel = {
  id: 'a1', guguNumber: null, displayName: 'Claude 28', avatar: null, bio: null, email: null, type: 'agent',
  role: 'member', profileScope: 'group', listenMode: 'active', ownerUserId: 'owner-1',
}
const opened = (openedFrom: 'main' | 'aside'): ActiveMemberProfile => ({
  member: groupMember, anchor: document.createElement('div'), preferredSide: 'right', openedFrom,
})
const groupEdit = { onChangeListenMode: vi.fn(async () => {}), busy: false }

let harness: ReturnType<typeof createReactHarness>
let result: ReturnType<typeof useTopicScopedMemberProfile>
function Probe(props: { profile: ActiveMemberProfile | null; topicChatId: string | null }) {
  result = useTopicScopedMemberProfile({ ...props, currentUserId: 'owner-1', groupEditControlsFor: () => groupEdit })
  return null
}
async function render(profile: ActiveMemberProfile | null, topicChatId: string | null = 'topic-1') {
  await harness.render(createNode(Probe, { profile, topicChatId }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

describe('useTopicScopedMemberProfile', () => {
  it('分栏点开:显示话题里的档位,改档写到话题 id', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render(opened('aside'))
    expect(getGroupCollab).toHaveBeenCalledWith('topic-1')
    expect(result?.profile.member.listenMode).toBe('passive')
    expect(result?.editControls).not.toBe(groupEdit)
    await act(async () => { await result?.editControls?.onChangeListenMode?.('active') })
    expect(setAgentListenMode).toHaveBeenCalledWith('topic-1', 'a1', 'active')
  })

  it('反例:主线点开的名片原样走群的档位和群的编辑控件', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render(opened('main'))
    expect(result?.profile.member.listenMode).toBe('active')
    expect(result?.editControls).toBe(groupEdit)
  })

  it('agent 不在话题名册里:不画档位,也不拿群的档位顶上', async () => {
    getGroupCollab.mockRejectedValue(new Error('empty'))
    await render(opened('aside'))
    expect(result?.profile.member.profileScope).toBe('direct')
    expect(result?.profile.member.listenMode).toBeUndefined()
    expect(result?.editControls).toBeUndefined()
  })

  it('话题里看别人的 agent:即使是话题的 owner,档位也只读', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render({ ...opened('aside'), member: { ...groupMember, ownerUserId: 'member-9' } })
    expect(result?.profile.member.listenMode).toBe('passive')
    expect(result?.editControls).toBeUndefined()
  })
})
