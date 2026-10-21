// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupInvitationsPanel } from '../../../../apps/desktop/src/components/contacts/GroupInvitationsPanel'
import { NewFriendsPanel } from '../../../../apps/desktop/src/components/NewFriendsPanel'
import { decideGroupInvitation } from '../../../../apps/desktop/src/lib/groupInvitations'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/groupInvitations', () => ({ decideGroupInvitation: vi.fn() }))
const invitation = {
  id: 'invite-1', chat_id: 'group-1', group_name: '论文评审', inviter_agent_user_id: 'agent-a', inviter_name: '研究助手', inviter_owner_name: '小王',
  invitee_user_id: 'agent-b', invitee_name: '审稿助手', invitee_type: 'agent' as const, decision_user_id: 'owner-b',
  owner_will_join: true, message: '请来讨论实验结果', status: 'pending' as const, created_at: '2026-09-20T12:00:00Z',
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks() })
afterEach(() => harness.cleanup())

describe('group invitation owner consent', () => {
  it('explains both memberships and accepts the exact invitation', async () => {
    const refreshRequests = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(GroupInvitationsPanel), {
      contacts: { groupInvitations: [invitation], refreshRequests },
    })
    expect(harness.container.textContent).toContain('你和这个 Agent 将一同加入')
    expect(harness.container.textContent).toContain('审稿助手')
    await clickElement(harness.container.querySelector('[data-testid="group-invitation-accept"]') as HTMLButtonElement)
    expect(decideGroupInvitation).toHaveBeenCalledWith('invite-1', true)
    expect(refreshRequests).toHaveBeenCalledOnce()
  })
  it('keeps the invitation and displays an acceptance failure', async () => {
    vi.mocked(decideGroupInvitation).mockRejectedValueOnce(new Error('Group member limit reached'))
    const refreshRequests = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(GroupInvitationsPanel), {
      contacts: { groupInvitations: [invitation], refreshRequests },
    })
    await clickElement(harness.container.querySelector('[data-testid="group-invitation-accept"]') as HTMLButtonElement)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('群人数已满')
    expect(harness.container.textContent).not.toContain('Group member limit reached')
    expect(refreshRequests).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[data-testid="group-invitation"]')).not.toBeNull()
  })
  it('#6704 keeps a decided invitation with its outcome instead of the consent buttons', async () => {
    await renderWithAppProviders(harness, createNode(GroupInvitationsPanel), {
      contacts: { groupInvitations: [{ ...invitation, status: 'rejected' as const }] },
    })
    expect(harness.container.textContent).toContain('已拒绝')
    expect(harness.container.textContent).not.toContain('你和这个 Agent 将一同加入')
    expect(harness.container.querySelector('[data-testid="group-invitation-accept"]')).toBeNull()
  })
  it('declines without refreshing the joined conversation list', async () => {
    const refreshChats = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(GroupInvitationsPanel), {
      chat: { refreshChats },
      contacts: { groupInvitations: [invitation] },
    })
    await clickElement(harness.container.querySelector('[data-testid="group-invitation-reject"]') as HTMLButtonElement)
    expect(decideGroupInvitation).toHaveBeenCalledWith('invite-1', false)
    expect(refreshChats).not.toHaveBeenCalled()
  })
  it('shows the pending invitation on its own discoverable requests tab', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel), {
      contacts: { groupInvitations: [invitation] },
    })
    const tab = [...harness.container.querySelectorAll('[role="tab"]')].find((element) => element.textContent?.includes('群聊')) as HTMLButtonElement // @@@6418 页签改名「群聊」:群邀请 + 入群申请
    expect(tab.textContent).toContain('1')
    await clickElement(tab)
    expect(harness.container.querySelector('#gg-req-panel-groups')?.hasAttribute('hidden')).toBe(false)
  })
  it('does not present failed loading as an empty inbox', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel), {
      contacts: { groupInvitations: [], requestsStatus: 'error', requestsError: 'network unavailable' },
    })
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(harness.container.textContent).not.toContain('network unavailable')
    expect(harness.container.textContent).not.toContain('暂无待处理的群邀请')
  })
})
