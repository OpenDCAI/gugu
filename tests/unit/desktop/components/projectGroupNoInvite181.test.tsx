// @vitest-environment jsdom
// gugu-dev#181(yangchichi 10-23「项目群是我的 agent 和我交流的地方,没有第三者」):项目群里不提供拉人类进来的入口,
// 每处说一句原因;普通群照旧。判断只有一处(isProjectGroupChat → projectGroupsStore.projectOfChat)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChatSettings } from '../../../../packages/core/src/shared/types/chat'
import { act } from 'react'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const projectGroups = new Set<string>()
vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { projectOfChat: (chatId: string) => (projectGroups.has(chatId) ? 'project-1' : undefined) },
}))
vi.mock('../../../../apps/desktop/src/components/chat/GroupAgentFloodSettings', () => ({ GroupAgentFloodSettings: () => null }))

const { isProjectGroupChat } = await import('../../../../apps/desktop/src/lib/groupMemberPermissions')
const { GroupSettingsManagePage } = await import('../../../../apps/desktop/src/components/chat/GroupSettingsManagePage')
const { AddGroupMembers } = await import('../../../../apps/desktop/src/components/chat/AddGroupMembers')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); projectGroups.clear() })
afterEach(() => { harness.cleanup() })

const settings = {
  max_members: 500, allow_member_invite: true, invite_link_enabled: true, agent_join_approval: false, join_mode: 'open',
} as unknown as GroupChatSettings
const REASON = '项目群只有你和你的 agent。要与其他人协作，请在对话中新建群聊。'
const manage = (chatId: string) => createNode(GroupSettingsManagePage, {
  chatId, settings, totalMembers: 1, inviteLink: 'https://gugu.test/g/1', onUpdate: vi.fn(async () => true), onOpenPoster: vi.fn(),
})

describe('a project group offers no way to bring people in', () => {
  it('knows a project group from the project bindings alone', () => {
    projectGroups.add('pg')
    expect(isProjectGroupChat('pg')).toBe(true)
    expect(isProjectGroupChat('ordinary')).toBe(false)
  })

  it('group management: the join mode, member invites and the invite link give way to the reason', async () => {
    projectGroups.add('pg')
    await renderWithAppProviders(harness, manage('pg'))
    expect(harness.container.textContent).toContain(REASON)
    expect(harness.container.querySelector('[data-testid="group-invite-link"]')).toBeNull()
    expect(harness.container.querySelector('select')).toBeNull()
  })

  it('positive control: an ordinary group keeps them', async () => {
    await renderWithAppProviders(harness, manage('ordinary'))
    expect(harness.container.textContent).not.toContain(REASON)
    expect(harness.container.querySelector('[data-testid="group-invite-link"]')).not.toBeNull()
    expect(harness.container.querySelector('select')).not.toBeNull()
  })

  it('the member picker says why its people page is empty', async () => {
    await renderWithAppProviders(harness, createNode(AddGroupMembers, {
      chatId: 'pg', snapshot: { humans: [], agents: [] } as never, canInviteHumans: false, humanDeniedHint: REASON,
      onClose: vi.fn(), onReload: vi.fn(async () => {}),
    }))
    // It does not open on people (your own agents still join); the people source says why it is empty.
    expect(document.body.textContent).not.toContain(REASON)
    await act(async () => { document.querySelector<HTMLElement>('[data-picker-source="people"]')!.click() })
    expect(document.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.groupMembersPickerHumanDenied}"]`)?.textContent).toBe(REASON)
  })
})
