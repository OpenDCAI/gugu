// @vitest-environment jsdom
//
// #6727 改群名在触屏上要有看得见的入口:群主 / 管理员的群名旁有编辑钮,点一下进输入态,回车写库;
// 普通成员没有这颗钮(反例)。写库走的仍是群设置那一条 updateGroupChatSettings。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChatSettings, GroupCollabSnapshot, GroupMemberItem } from '../../../packages/core/src/shared/types/chat'
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders, waitForCondition } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getGroupChatSettings: vi.fn(),
    updateGroupChatSettings: vi.fn(),
    listGroupJoinRequests: vi.fn(async () => []),
    decideGroupJoin: vi.fn(async () => {}),
    getGroupCollab: vi.fn(async () => ({ snapshot: { humans: [], agents: [] }, identities: [] })),
    uploadGroupAvatar: vi.fn(),
    leaveGroup: vi.fn(async () => {}),
  },
  GroupCollabEmptyError: class GroupCollabEmptyError extends Error {},
}))
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: { listTopicsOfChat: vi.fn(async () => []) },
}))

const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { GroupMembersSection } = await import('../../../apps/desktop/src/components/chat/GroupMembersSection')
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const updateSettings = vi.mocked(chatService.updateGroupChatSettings)

function settingsRow(overrides: Partial<GroupChatSettings> = {}): GroupChatSettings {
  return {
    my_role: 'owner', can_manage: true, can_dissolve: true, can_archive_topic: false,
    id: 'chat-1', public_id: 7, creator_user_id: 'owner-1', name: '产品组', status: 'active',
    group_prompt: null, default_agent_type: null, join_token: 'token', description: null,
    max_members: 100, allow_member_invite: false, invite_link_enabled: false, agent_join_approval: false,
    join_mode: 'approval', hide_history: false, avatar_url: null, is_discoverable: false,
    agent_flood_threshold: null, agent_flood_threshold_effective: 5,
    ...overrides,
  } as GroupChatSettings
}
const human = (id: string, role: GroupMemberItem['role']): GroupMemberItem => ({ id, role, type: 'human', account_status: null })
const SNAPSHOT: GroupCollabSnapshot = {
  scheduler: { chat_id: 'chat-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-28T00:00:00.000Z' },
  humans: [human('owner-1', 'owner'), human('member-1', 'member')],
  agents: [], tasks: [],
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  getSettings.mockResolvedValue(settingsRow())
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null

async function renderSettings(viewerId: string) {
  if (viewerId !== 'owner-1') getSettings.mockResolvedValue(settingsRow({ my_role: 'member', can_manage: false, can_dissolve: false }))
  await renderWithAppProviders(harness, createNode(GroupMembersSection, {
    chat: chat({ id: 'chat-1', kind: 'group', name: '产品组' }),
    snapshot: SNAPSHOT,
    currentUserId: viewerId,
    onReload: vi.fn(async () => {}),
    onClose: vi.fn(),
    onOpenSearch: vi.fn(),
    onSetNotificationLevel: vi.fn(async () => {}),
    onTogglePinned: vi.fn(async () => {}),
    onClearMessages: vi.fn(async () => {}),
    onLeaveGroup: vi.fn(async () => {}),
  }), {
    auth: { id: viewerId },
    chat: {
      identitiesById: { 'owner-1': displayIdentity('owner-1', { display_name: '群主甲' }), 'member-1': displayIdentity('member-1', { display_name: '成员乙' }) },
      getImRepository: async () => ({ putIdentities: vi.fn(async () => {}) }) as never,
    },
    contacts: { contacts: [] },
  })
  // 群名在设置读到之前就有(取自会话行);等的是设置本身落地 —— 编辑钮要等它才判得出能不能改。
  await waitForCondition(() => q('[data-testid="group-settings-rules"]')?.textContent?.includes('未设置协作规则') === true, 'settings loaded')
}

describe('#6727 改群名的可见入口', () => {
  it('群主:名字旁有编辑钮,点一下进输入态,回车只写 name', async () => {
    updateSettings.mockResolvedValue(settingsRow({ name: '新群名' }))
    await renderSettings('owner-1')
    const edit = q('[data-testid="group-name-edit"]')
    expect(edit?.getAttribute('aria-label')).toBe('编辑群名')
    await act(async () => { edit!.click() })
    const input = q('[data-group-settings-page="main"] input[placeholder="群名称"]') as HTMLInputElement
    expect(input?.value).toBe('产品组')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, '新群名')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith('chat-1', { name: '新群名' })
    await waitForCondition(() => q('[data-testid="group-name-display"]')?.textContent === '新群名', 'renamed')
  })

  it('#6791 群设置页里的群名换行显示全名,不截断', async () => {
    await renderSettings('member-1')
    const display = q('[data-testid="group-name-display"]')!
    expect(display.style.whiteSpace).not.toBe('nowrap')
    expect(display.style.textOverflow).not.toBe('ellipsis')
    expect(display.style.overflowWrap).toBe('anywhere')
  })

  it('反例:普通成员没有编辑钮,点名字也不进输入态', async () => {
    await renderSettings('member-1')
    expect(q('[data-testid="group-name-edit"]')).toBeNull()
    await act(async () => { q('[data-testid="group-name-display"]')!.click() })
    expect(q('[data-group-settings-page="main"] input[placeholder="群名称"]')).toBeNull()
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
