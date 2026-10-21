// @vitest-environment jsdom
//
// @@@6418 群成员面板成为「和人有关的操作」的唯一入口。判据钉的是会被悄悄做坏的几处:
//   ① 搜索按行上看得见的字匹配(名字 / 主人 / 引擎),而且真的会滤掉不匹配的行 —— 带反例。
//   ② 入群申请在面板里原地打开,返回回到**成员列表**(owner 在 mock 里点出来的 bug:
//      原来跳进设置抽屉的「群管理 → 入群申请」,一按返回就落到了群管理)。
//   ③ 普通成员:没有申请入口;点一行打开的资料卡没有角色 / 移出控件。带正例:群主看得到。
//   ④ 群主的 ⋯ 快捷菜单真的调到移出成员,并重读名册。
//   ⑤ 主动 / 被动归 agent 的主人(owner 10-17):主人改得动、能让它退群;群主改不动别人的 agent,改得动自己的。
import { act, Fragment, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupAgentItem, GroupCollabSnapshot, GroupMemberItem } from '../../../packages/core/src/shared/types/chat'
import type { DisplayIdentity } from '../../../apps/desktop/src/lib/displayIdentity'
import { createNode, createReactHarness, displayIdentity, renderWithAppProviders, typeInto, waitForCondition } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getGroupCollab: vi.fn(),
    getGroupChatSettings: vi.fn(),
    listGroupJoinRequests: vi.fn(),
    decideGroupJoin: vi.fn(async () => {}),
    setAgentListenMode: vi.fn(async () => {}),
    setGroupMemberRole: vi.fn(async () => {}),
    removeGroupMember: vi.fn(async () => {}),
  },
  GroupCollabEmptyError: class GroupCollabEmptyError extends Error {},
}))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readRequiredDisplayIdentities: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, type: 'human', display_name: `申请人-${id}` }))),
  readCommunityPoints: vi.fn(async () => 0),
}))

const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { MemberListPanel } = await import('../../../apps/desktop/src/components/chat/MemberListPanel')

const getGroupCollab = vi.mocked(chatService.getGroupCollab)
const listJoinRequests = vi.mocked(chatService.listGroupJoinRequests)
const removeMember = vi.mocked(chatService.removeGroupMember)
const setListenMode = vi.mocked(chatService.setAgentListenMode)

function agentItem(id: string, overrides: Partial<GroupAgentItem> = {}): GroupAgentItem {
  return {
    id, role: 'member', type: 'agent', account_status: 'active', client: null, model_source: null, tools: [],
    permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null,
    listen_mode: 'passive', ...overrides,
  }
}
function humanItem(id: string, role: GroupMemberItem['role'] = 'member'): GroupMemberItem {
  return { id, role, type: 'human', account_status: null }
}
function collab(agents: GroupAgentItem[], humans: GroupMemberItem[]): GroupCollabSnapshot {
  return {
    scheduler: { chat_id: 'chat-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-24T00:00:00.000Z' },
    humans, agents, tasks: [], outputs: [],
  }
}
const SNAPSHOT = collab(
  [agentItem('codex', { client: 'Codex', model_source: 'gpt-5.4' }), agentItem('claude', { client: 'Claude' })],
  [humanItem('owner-1', 'owner'), humanItem('member-1'), humanItem('member-2')],
)
const IDENTITIES: DisplayIdentity[] = [
  displayIdentity('owner-1', { display_name: '群主甲' }),
  displayIdentity('member-1', { display_name: '成员乙' }),
  displayIdentity('member-2', { display_name: '成员丙' }),
  displayIdentity('codex', { type: 'agent', display_name: '写代码的', owner_user_id: 'member-1' }),
  displayIdentity('claude', { type: 'agent', display_name: '写文档的', owner_user_id: 'owner-1' }),
]

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  getGroupCollab.mockResolvedValue({ snapshot: SNAPSHOT, identities: IDENTITIES })
  listJoinRequests.mockResolvedValue([])
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

const head = (title: ReactNode, actions: ReactNode) => createNode(Fragment, null, title, actions)
let revisionListeners: Array<{ event: unknown; listener: (operations: { revision: string; event: string; payload: unknown }[]) => void }> = []
async function renderPanel(viewerId = 'owner-1', chatId = 'chat-1') {
  revisionListeners = []
  await renderWithAppProviders(
    harness,
    createNode(MemberListPanel, { chatId, chatKind: 'group', head }),
    { auth: { id: viewerId }, chat: {
      identitiesById: {}, getImRepository: async () => ({ putIdentities: vi.fn(async () => {}) }) as never,
      subscribeAccountRevision: ((event: unknown, listener: never) => {
        const entry = { event, listener }
        revisionListeners.push(entry)
        return () => { revisionListeners = revisionListeners.filter((other) => other !== entry) }
      }) as never,
    }, contacts: { contacts: [] } },
  )
  await waitForCondition(() => rowIds().length > 0, 'member rows rendered')
}
const rowIds = () => [...harness.container.querySelectorAll('[data-member-row]')].map((row) => row.getAttribute('data-member-row'))
const q = (selector: string) => document.querySelector(selector) as HTMLElement | null
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => { element!.click(); await Promise.resolve(); await Promise.resolve() })
}

describe('#6418 群成员面板 —— 搜索', () => {
  it('按名字、主人、引擎匹配,并真的滤掉不匹配的行', async () => {
    await renderPanel()
    expect(rowIds()).toEqual(['owner-1', 'member-1', 'member-2', 'claude', 'codex'])
    const input = q('[data-testid="member-list-search"] input, input[data-testid="member-list-search"]') as HTMLInputElement
    expect(input).not.toBeNull()

    await typeInto(input, '成员乙')
    expect(rowIds()).toEqual(['member-1', 'codex']) // codex 的主人是成员乙
    await typeInto(input, 'codex')
    expect(rowIds()).toEqual(['codex'])
    await typeInto(input, '没有这个人')
    expect(rowIds()).toEqual([])
    expect(q('[data-testid="member-list-no-match"]')?.textContent).toContain('没有这个人')
    await typeInto(input, '')
    expect(rowIds()).toHaveLength(5)
  })
})

describe('#6418 群成员面板 —— 入群申请不在这里', () => {
  it('群主打开面板:不读入群申请、也没有申请入口(申请归通讯录「新的请求」)', async () => {
    listJoinRequests.mockResolvedValue([
      { id: 'req-1', chat_id: 'chat-1', requester_user_id: 'applicant-1', requester_type: 'human', requested_by_user_id: null, message: '想加入', status: 'pending', created_at: '2026-09-24T00:00:00.000Z' },
    ] as never)
    await renderPanel('owner-1')
    expect(listJoinRequests).not.toHaveBeenCalled()
    expect(q('[data-testid="member-list-join-requests"]')).toBeNull()
    expect(document.body.textContent).not.toContain('入群申请')
  })
})

describe('#6418 群成员面板 —— 资料卡与管理', () => {
  it('普通成员点一行:资料卡打开,但没有角色 / 移出控件', async () => {
    await renderPanel('member-2')
    await click(q('[data-member-row="member-1"]'))
    await waitForCondition(() => q('[data-testid="group-member-profile-menu"]') !== null, 'profile card open')
    expect(q('[data-testid="group-member-profile-menu"] select')).toBeNull()
    expect(q('[data-testid="group-member-profile-menu"]')?.textContent).not.toContain('移出群聊')
  })

  it('反例:群主点同一行,资料卡里有角色选择与移出', async () => {
    await renderPanel('owner-1')
    await click(q('[data-member-row="member-1"]'))
    await waitForCondition(() => q('[data-testid="group-member-profile-menu"]') !== null, 'profile card open')
    expect(q('[data-testid="group-member-profile-menu"] select')).not.toBeNull()
    expect(q('[data-testid="group-member-profile-menu"]')?.textContent).toContain('移出群聊')
  })

  it('群主行尾 ⋯ → 移出群聊:调到 removeGroupMember 并重读名册;群主自己那行没有 ⋯', async () => {
    await renderPanel('owner-1')
    expect(q('[data-member-row="owner-1"] button[aria-label^="管理"]')).toBeNull()
    await click(q('[data-member-row="codex"] button[aria-label^="管理"]'))
    await waitForCondition(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === '移出群聊'), 'menu open')
    const removeItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '移出群聊') as HTMLElement
    const readsBefore = getGroupCollab.mock.calls.length
    await click(removeItem)
    await waitForCondition(() => removeMember.mock.calls.length === 1, 'remove called')
    expect(removeMember).toHaveBeenCalledWith('chat-1', 'codex')
    await waitForCondition(() => getGroupCollab.mock.calls.length > readsBefore, 'roster reloaded')
  })

  it('普通成员看不到任何 ⋯ 管理钮', async () => {
    await renderPanel('member-2')
    expect(q('[data-testid="member-list-panel"] button[aria-label^="管理"]')).toBeNull()
  })
})

describe('名册跟着 chat_members 的修订重读(不靠宿主换 key 重挂)', () => {
  const fire = async (chatId: string) => {
    const membership = revisionListeners.filter((entry) => entry.event === 'chat_members_changed')
    expect(membership).toHaveLength(1)
    await act(async () => { membership[0]!.listener([{ revision: '1', event: 'chat_members_changed', payload: { chat_id: chatId, user_id: 'agent-1' } }]); await Promise.resolve() })
  }

  it('本群成员行变了(如撤回刷屏把档位改回):重读名册', async () => {
    await renderPanel('owner-1')
    const before = getGroupCollab.mock.calls.length
    await fire('chat-1')
    expect(getGroupCollab.mock.calls.length).toBe(before + 1)
  })

  it('反例:别的群的成员变动不触发重读', async () => {
    await renderPanel('owner-1')
    const before = getGroupCollab.mock.calls.length
    await fire('chat-2')
    expect(getGroupCollab.mock.calls.length).toBe(before)
  })
})

describe('主动 / 被动归 agent 的主人', () => {
  // 点击都包在 act 里冲刷过(见 click):mutation 在 onClick 里同步发出、菜单与资料卡随那次渲染出来,直接断言,不等墙钟。
  const toggle = (agentId: string) => q(`[data-member-row="${agentId}"] [data-listen-mode-toggle]`) as HTMLElement | null
  const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  const card = () => q('[data-testid="group-member-profile-menu"]')
  const segment = (label: string) => [...(card()?.querySelectorAll('.gg-pop-lmseg-btn') ?? [])].find((b) => b.textContent === label) as HTMLElement | undefined

  it('普通成员改得动自己的 agent,改不动别人的', async () => {
    await renderPanel('member-1')
    await click(toggle('claude'))
    expect(setListenMode).not.toHaveBeenCalled()
    await click(toggle('codex'))
    expect(setListenMode.mock.calls).toEqual([['chat-1', 'codex', 'active']])
  })

  it('群主改不动别人的 agent;同一个人改自己的 agent 照样改得动', async () => {
    await renderPanel('owner-1')
    await click(toggle('codex'))
    expect(setListenMode).not.toHaveBeenCalled()
    await click(toggle('claude'))
    expect(setListenMode.mock.calls).toEqual([['chat-1', 'claude', 'active']])
  })

  it('群主打开别人 agent 的资料卡:档位分段只读,角色与移出还在;打开自己 agent 的就能改', async () => {
    await renderPanel('owner-1')
    await click(q('[data-member-row="codex"]'))
    expect(card()).not.toBeNull()
    await click(segment('主动') ?? null)
    expect(setListenMode).not.toHaveBeenCalled()
    expect(q('[data-testid="group-member-profile-menu"] select')).not.toBeNull()
    expect(q('[data-profile-remove-button="codex"]')?.textContent).toBe('移出群聊')
    // 阳控:同一张卡、同一个分段,换成群主自己的 agent 就真的改了。
    await click(q('[data-member-row="claude"]'))
    await click(segment('主动') ?? null)
    expect(setListenMode.mock.calls).toEqual([['chat-1', 'claude', 'active']])
  })

  it('群主的 ⋯ 对别人的 agent 没有改档位那一项', async () => {
    await renderPanel('owner-1')
    await click(q('[data-member-row="codex"] button[aria-label^="管理"]'))
    expect(menuItems()).toEqual(['设为管理员', '移出群聊'])
  })

  it('普通成员只在自己的 agent 上有 ⋯:改档位、让它退出群聊', async () => {
    await renderPanel('member-1')
    expect(q('[data-member-row="claude"] button[aria-label^="管理"]')).toBeNull()
    expect(q('[data-member-row="member-2"] button[aria-label^="管理"]')).toBeNull()
    await click(q('[data-member-row="codex"] button[aria-label^="管理"]'))
    expect(menuItems()).toEqual(['改为主动', '让它退出群聊'])
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '让它退出群聊') as HTMLElement)
    expect(removeMember.mock.calls).toEqual([['chat-1', 'codex']])
  })

  it('普通成员点开自己 agent 的资料卡:没有角色选择,有「让它退出群聊」', async () => {
    await renderPanel('member-1')
    await click(q('[data-member-row="codex"]'))
    expect(card()).not.toBeNull()
    expect(q('[data-testid="group-member-profile-menu"] select')).toBeNull()
    expect(q('[data-profile-remove-button="codex"]')?.textContent).toBe('让它退出群聊')
  })

  it('没改成:行上写出原因,不是「点了没反应」;下一次点击先清掉', async () => {
    setListenMode.mockRejectedValueOnce(new Error('permission denied (内部原因,不上屏)'))
    await renderPanel('member-1')
    await click(toggle('codex'))
    // 拒绝在 onClick 那次 act 之后的微任务里落地:再冲刷一轮。
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
    // 一句对任何失败(断网、会话过期、被拦下)都成立的话;内部原因不上屏。
    expect(q('[data-listen-mode-error="codex"]')?.textContent).toBe('没改成，档位还是原来的')
    expect(q('[data-listen-mode-error="claude"]')).toBeNull()
    await click(toggle('codex'))
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
    expect(q('[data-listen-mode-error="codex"]')).toBeNull()
  })

  it('失败记在「这个群里的这个 agent」上:换到别的群,同一个 agent 不显示;换回来还在', async () => {
    setListenMode.mockRejectedValueOnce(new Error('offline'))
    await renderPanel('member-1', 'chat-1')
    await click(toggle('codex'))
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
    expect(q('[data-listen-mode-error="codex"]')).not.toBeNull()
    // 同一个面板实例换群重渲(右栏 / 消息区头像卡那份 hook 跨群不重挂)。
    await renderPanel('member-1', 'chat-2')
    expect(q('[data-listen-mode-error="codex"]')).toBeNull()
    // 阳控:换回来还在 —— 证明上面是按群过滤掉的,不是面板重挂把状态清了。
    await renderPanel('member-1', 'chat-1')
    expect(q('[data-listen-mode-error="codex"]')).not.toBeNull()
  })
})
