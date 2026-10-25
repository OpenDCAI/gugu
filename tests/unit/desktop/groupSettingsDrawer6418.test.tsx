// @vitest-environment jsdom
//
// @@@6418 群聊设置抽屉改成页面栈 + 即时生效。判据钉的是:
//   ① 没有底部「保存」:开关一拨就调 updateGroupChatSettings,只带那一个字段。
//   ② 写失败回滚到库里的值,并把原因显示出来 —— ❌ 停在一个没写进去的值上。
//   ③ 群管理只对群主/管理员存在(普通成员连入口都没有,不是一排禁用开关)。带正例。
//   ④ 「群成员」「群公告」是设置栈里的一页:页头与其它二级页同一个,返回(含安卓返回键)回到一级页。
//      一级页上没有第二份名单。
//   ⑤ 协作规则在二级页编辑,「完成」才写,写完回到一级页。
//   ⑥ 离开群组走抽屉内确认,❌ window.confirm。
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
    getAnnouncements: vi.fn(async () => []),
    leaveGroup: vi.fn(async () => {}),
  },
  GroupCollabEmptyError: class GroupCollabEmptyError extends Error {},
}))
const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: { listTopicsOfChat: vi.fn(async () => []) },
}))

const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { GroupMembersSection } = await import('../../../apps/desktop/src/components/chat/GroupMembersSection')
const { NATIVE_BACK_EVENT } = await import('../../../apps/desktop/src/components/ui/sheetStack')
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const updateSettings = vi.mocked(chatService.updateGroupChatSettings)

function settingsRow(overrides: Partial<GroupChatSettings> = {}): GroupChatSettings {
  return {
    id: 'chat-1', public_id: 7, creator_user_id: 'owner-1', name: '产品组', status: 'active',
    group_prompt: '先写 spec 再开工\n第二条', default_agent_type: null, join_token: 'token', description: null,
    max_members: 100, allow_member_invite: false, invite_link_enabled: false, agent_join_approval: false,
    join_mode: 'approval', hide_history: false, avatar_url: null, is_discoverable: false,
    agent_flood_threshold: null, agent_flood_threshold_effective: 5,
    ...overrides,
  } as GroupChatSettings
}
function humanItem(id: string, role: GroupMemberItem['role'] = 'member'): GroupMemberItem {
  return { id, role, type: 'human', account_status: null }
}
const SNAPSHOT: GroupCollabSnapshot = {
  scheduler: { chat_id: 'chat-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-24T00:00:00.000Z' },
  humans: [humanItem('owner-1', 'owner'), humanItem('member-1')],
  agents: [], tasks: [], outputs: [],
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  getSettings.mockResolvedValue(settingsRow())
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks(); shell.mobile = false })

async function renderDrawer(viewerId: string, callbacks: Record<string, unknown> = {}, waitForSettings = true) {
  const props = {
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
    ...callbacks,
  }
  await renderWithAppProviders(harness, createNode(GroupMembersSection, props), {
    auth: { id: viewerId },
    chat: {
      identitiesById: { 'owner-1': displayIdentity('owner-1', { display_name: '群主甲' }), 'member-1': displayIdentity('member-1', { display_name: '成员乙' }) },
      getImRepository: async () => ({ putIdentities: vi.fn(async () => {}) }) as never,
    },
    contacts: { contacts: [] },
  })
  if (waitForSettings) await waitForCondition(() => q('[data-testid="group-settings-rules"]')?.textContent?.includes('先写 spec') === true, 'settings loaded')
  return props
}
const q = (selector: string) => document.querySelector(selector) as HTMLElement | null
const page = () => q('[data-group-settings-page]')?.getAttribute('data-group-settings-page')
async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => { element!.click(); await Promise.resolve(); await Promise.resolve() })
}
const buttonByText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLElement | undefined
const switchByLabel = (label: string) => q(`[data-slot="switch"][aria-label="${label}"]`)

describe('#6418 群聊设置 —— 即时生效', () => {
  it('没有「保存」;群管理里拨一个开关就只写那一个字段', async () => {
    updateSettings.mockResolvedValue(settingsRow({ allow_member_invite: true }))
    await renderDrawer('owner-1')
    expect(buttonByText('保存')).toBeUndefined()
    await click(q('[data-testid="group-settings-manage"]'))
    expect(page()).toBe('manage')
    const toggle = switchByLabel('允许普通成员邀请联系人')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith('chat-1', { allow_member_invite: true })
    await waitForCondition(() => switchByLabel('允许普通成员邀请联系人')?.getAttribute('aria-checked') === 'true', 'switch on')
  })

  it('写失败:回滚到库里的值,并显示原因', async () => {
    updateSettings.mockRejectedValue(new Error('permission denied'))
    await renderDrawer('owner-1')
    await click(q('[data-testid="group-settings-manage"]'))
    await click(switchByLabel('允许普通成员邀请联系人'))
    await waitForCondition(() => q('[role="alert"]')?.textContent?.includes('permission denied') === true, 'error shown')
    expect(q('[role="alert"]')?.textContent).toContain('permission denied')
    expect(switchByLabel('允许普通成员邀请联系人')?.getAttribute('aria-checked')).toBe('false')
  })
})

describe('#6418 群聊设置 —— 并发与非法输入(code review 回归)', () => {
  it('连拨两个开关、响应乱序回来:每次写只认领自己的字段,两个都停在库里的值', async () => {
    const first = { resolve: (_: GroupChatSettings) => {} }
    updateSettings
      .mockImplementationOnce(() => new Promise((resolve) => { first.resolve = resolve }))
      // 第二次写先回来;它的返回里 allow_member_invite 还是旧值 false —— 不许把第一次写的乐观值盖回去。
      .mockImplementationOnce(async () => settingsRow({ agent_join_approval: true }))
    await renderDrawer('owner-1')
    await click(q('[data-testid="group-settings-manage"]'))
    await click(switchByLabel('允许普通成员邀请联系人'))
    await click(switchByLabel('Agent 加入需要审批'))
    await waitForCondition(() => switchByLabel('Agent 加入需要审批')?.getAttribute('aria-checked') === 'true', 'second on')
    expect(switchByLabel('允许普通成员邀请联系人')?.getAttribute('aria-checked')).toBe('true')
    // 第一次写最后才回来,它的返回里 agent_join_approval 是旧值 false —— 同样不许盖掉第二次写。
    await act(async () => { first.resolve(settingsRow({ allow_member_invite: true })) })
    expect(switchByLabel('允许普通成员邀请联系人')?.getAttribute('aria-checked')).toBe('true')
    expect(switchByLabel('Agent 加入需要审批')?.getAttribute('aria-checked')).toBe('true')
  })

  it('设置还没读到时点协作规则不进编辑页(否则空草稿一点「完成」就清掉库里的规则)', async () => {
    getSettings.mockImplementation(() => new Promise(() => {}))
    await renderDrawer('owner-1', {}, false)
    await click(q('[data-testid="group-settings-rules"]'))
    expect(page()).toBe('main')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('成员上限填空:不发请求、不闪 NaN,提示原因', async () => {
    await renderDrawer('owner-1')
    await click(q('[data-testid="group-settings-manage"]'))
    const input = q('input[type="number"][aria-label="成员上限"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.focus(); input.blur() })
    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.value).not.toContain('NaN')
    expect(q('[role="alert"]')?.textContent).toContain('成员上限必须是')
  })
})

describe('#6418 群聊设置 —— 谁看得到什么', () => {
  it('邀请链接开着时,普通成员在一级页也能复制链接 / 生成海报(改版前就能)', async () => {
    getSettings.mockResolvedValue(settingsRow({ invite_link_enabled: true }))
    await renderDrawer('member-1')
    expect(q('[data-testid="group-invite-link"]')).not.toBeNull()
  })

  it('反例:邀请链接关着时,普通成员看不到链接', async () => {
    await renderDrawer('member-1')
    expect(q('[data-testid="group-invite-link"]')).toBeNull()
  })

  it('普通成员没有「群管理」入口', async () => {
    await renderDrawer('member-1')
    expect(q('[data-testid="group-settings-manage"]')).toBeNull()
  })

  it('反例:群主有「群管理」入口', async () => {
    await renderDrawer('owner-1')
    expect(q('[data-testid="group-settings-manage"]')).not.toBeNull()
  })

  it('一级页上没有成员名单,名单在「群成员」那一页', async () => {
    await renderDrawer('member-1')
    expect(document.querySelector('[data-member-row]')).toBeNull()
    await click(q('[data-testid="group-settings-members"]'))
    expect(page()).toBe('members')
    expect(q('[data-testid="member-list-panel"]')).not.toBeNull()
  })
})

describe('群成员 / 群公告是设置栈里的一页', () => {
  const backButton = () => q('[aria-label="返回"]')
  const closeButton = () => q('[aria-label="关闭"]')

  it.each([
    ['group-settings-members', 'members'],
    ['group-settings-announcement', 'announcement'],
  ])('桌面:%s 进去有返回也有关闭,返回回到一级页', async (testId, target) => {
    const props = await renderDrawer('member-1')
    expect(backButton()).toBeNull()
    await click(q(`[data-testid="${testId}"]`))
    expect(page()).toBe(target)
    expect(closeButton()).not.toBeNull()
    await click(backButton())
    expect(page()).toBe('main')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it.each([
    ['group-settings-members', 'members'],
    ['group-settings-announcement', 'announcement'],
  ])('手机:%s 页的安卓返回键回到一级页,再按一次才关设置', async (testId, target) => {
    shell.mobile = true
    const props = await renderDrawer('member-1')
    await click(q(`[data-testid="${testId}"]`))
    expect(page()).toBe(target)
    expect(closeButton()).toBeNull()
    await act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT)) })
    expect(page()).toBe('main')
    expect(props.onClose).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT)) })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('#6418 群聊设置 —— 二级页', () => {
  it('协作规则:「完成」才写,写完回到一级页', async () => {
    updateSettings.mockResolvedValue(settingsRow({ group_prompt: '新的规则' }))
    await renderDrawer('owner-1')
    await click(q('[data-testid="group-settings-rules"]'))
    expect(page()).toBe('rules')
    const textarea = q('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('先写 spec 再开工\n第二条')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '新的规则')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(updateSettings).not.toHaveBeenCalled()
    await click(buttonByText('完成'))
    expect(updateSettings).toHaveBeenCalledWith('chat-1', { group_prompt: '新的规则' })
    await waitForCondition(() => page() === 'main', 'back to main')
  })

  it('离开群组走抽屉内确认,❌ window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const props = await renderDrawer('member-1')
    await click(q('[data-testid="group-settings-exit"]'))
    expect(props.onLeaveGroup).not.toHaveBeenCalled()
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === '离开群组')
    await click(buttons[buttons.length - 1] as HTMLElement)
    expect(props.onLeaveGroup).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
