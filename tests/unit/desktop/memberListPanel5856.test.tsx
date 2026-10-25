// @vitest-environment jsdom
//
// @@@5856 成员面板 + 自动调档系统消息的判据 —— product spec「成员与响应档位」。
// 钉的都是**会被悄悄做坏**的地方:
//   ① 引擎/模型拿不到时**整格不渲染**,而不是「未知 / — / 默认模型」这类看着正常的假值。
//      同样带正例:给得出值的时候这两格必须真的出现,否则「永远不渲染」也能过。
//      引擎还多一条:权威快照的 client 全产品没有写者(恒为 null),所以它必须能从联系人档的
//      agent_type 兜住 —— 不然 spec 要求的「每个 agent 一行显示它的引擎」在真实数据下永远是空的。
//   ② 台账已经撤回过,那条系统消息上就不该再有「全部撤回」。带正例:没撤回时按钮必须在。
//   ③ agent 数量线那一行(owner 2026-09-19「这个数字可以放在设置中,而不是硬编码」):
//      数量线统一在来源会话设置,群与话题成员面板均不再包含设置,
//      显示的数只能来自服务端的生效值,❌ 不许客户端自己编一个 5 出来。
import { act, Fragment, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
} from '../../../packages/core/src/shared/types/chat'
import type { DisplayIdentity } from '../../../apps/desktop/src/lib/displayIdentity'
import type { ContactUser } from '../../../packages/core/src/shared/types/contacts'
import type { AccountRevisionListener } from '../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { ChatContextValue } from '../../../apps/desktop/src/store/chatContext'
import { createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getGroupCollab: vi.fn(),
    setAgentListenMode: vi.fn(async () => {}),
    // @@@5856 话题的 agent 数量线那一行自己取自己存,走的就是这两条。
    getGroupChatSettings: vi.fn(),
    updateGroupChatSettings: vi.fn(),
    // @@@6418 群面板现在也读入群申请(群主/管理员);本文件不关心它,给一个空表。
    listGroupJoinRequests: vi.fn(async () => []),
  },
  // @@@5856 「名册是空的」不是故障,是「你还不是这条话题的参与者」—— 面板按这个类型分流。
  GroupCollabEmptyError: class GroupCollabEmptyError extends Error {},
}))
// presence 不是本文件的判据;用仓里现成的替身,免得把 presence 传输层拖进来。
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: vi.fn(async () => []),
    getAgentFloodAdjustment: vi.fn(),
    undoAgentFloodAdjustment: vi.fn(async () => 3),
  },
}))

const { chatService, GroupCollabEmptyError } = await import('../../../apps/desktop/src/lib/chat')
const { topicService } = await import('../../../apps/desktop/src/lib/topics')
const { MemberListPanelFixture: MemberListPanel } = await import('../../support/MemberListPanelFixture')
const { AgentFloodSystemNotice } = await import('../../../apps/desktop/src/components/chat/AgentFloodSystemNotice')

const getGroupCollab = vi.mocked(chatService.getGroupCollab)
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const updateSettings = vi.mocked(chatService.updateGroupChatSettings)
const getAdjustment = vi.mocked(topicService.getAgentFloodAdjustment)

function agentItem(id: string, overrides: Partial<GroupAgentItem> = {}): GroupAgentItem {
  return {
    id,
    role: 'member',
    type: 'agent',
    account_status: 'active',
    client: null,
    model_source: null,
    tools: [],
    permission_scope: null,
    current_task_id: null,
    current_task_title: null,
    last_action: null,
    last_active_at: null,
    listen_mode: 'passive',
    ...overrides,
  }
}

function humanItem(id: string, overrides: Partial<GroupMemberItem> = {}): GroupMemberItem {
  return { id, role: 'member', type: 'human', account_status: null, ...overrides }
}

function collab(agents: GroupAgentItem[], humans: GroupMemberItem[] = []): GroupCollabSnapshot {
  return {
    scheduler: {
      chat_id: 'chat-1', paused: false, queue_count: 0, blocked_count: 0,
      summary: null, updated_at: '2026-09-18T00:00:00.000Z',
    },
    humans,
    agents,
    tasks: [],
    outputs: [],
  }
}

function identitiesFor(snapshot: GroupCollabSnapshot): DisplayIdentity[] {
  return [
    ...snapshot.humans.map((human) => displayIdentity(human.id, { display_name: `人-${human.id}` })),
    ...snapshot.agents.map((agent) => displayIdentity(agent.id, { type: 'agent', display_name: `智能体-${agent.id}` })),
  ]
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  // 话题面板里那一行会自己去读设置;给一个缺省值,免得每条**不关心它**的用例都得记着桩一次。
  getSettings.mockResolvedValue(settingsRow(null, 5))
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

// 页头归宿主画;测试宿主把标题与动作原样摆出来(话题改名框、邀请按钮都在这两块里)。
const head = (title: ReactNode, actions: ReactNode) => createNode(Fragment, null, title, actions)

async function renderPanel(
  snapshot: GroupCollabSnapshot,
  contacts: ContactUser[] = [],
) {
  getGroupCollab.mockResolvedValue({ snapshot, identities: identitiesFor(snapshot) })
  await renderWithAppProviders(
    harness,
    createNode(MemberListPanel, { chatId: 'chat-1', chatKind: 'group', head }),
    { auth: { id: 'owner-1' }, chat: { identitiesById: {} }, contacts: { contacts } },
  )
  // 名册是异步读的:把 effect 里那条 promise 的 then 冲干净再断言。
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('@@@5856 名册读不到', () => {
  it('「看得见但还不是参与者」给的是照做能改变现状的话,❌ 不是「关掉再打开一次」', async () => {
    getGroupCollab.mockRejectedValueOnce(new GroupCollabEmptyError())
    await renderWithAppProviders(
      harness,
      createNode(MemberListPanel, { chatId: 'chat-1', chatKind: 'topic', head }),
      { auth: { id: 'owner-1' }, chat: { identitiesById: {} }, contacts: { contacts: [] } },
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const box = harness.container.querySelector('[data-testid="member-list-error"]')
    expect(box?.getAttribute('data-member-list-error')).toBe('not-participant')
    expect(box?.textContent).toContain('说一句就进来了')
    expect(box?.textContent).not.toContain('关掉再打开')
  })
})

describe('#5999 话题手动邀请', () => {
  const candidates = [
    { id: 'owner-1', name: '自己', type: 'human' as const },
    { id: 'existing', name: '已参与', type: 'agent' as const },
    { id: 'human-2', name: '同群成员', type: 'human' as const },
    { id: 'other-agent', name: '别人的 Agent', type: 'agent' as const },
  ]
  async function renderInvitation(send = vi.fn(async () => {}), participant = true) {
    const snapshot = collab([agentItem('existing')], [humanItem('owner-1')])
    if (participant) getGroupCollab.mockResolvedValue({ snapshot, identities: identitiesFor(snapshot) })
    else getGroupCollab.mockRejectedValueOnce(new GroupCollabEmptyError())
    await renderWithAppProviders(harness, createNode(MemberListPanel, {
      chatId: 'chat-1', chatKind: 'topic', head,
      topicInvitation: { candidates, send },
    }), { auth: { id: 'owner-1' }, chat: { identitiesById: {} }, contacts: { contacts: [] } })
    await click('[data-testid="topic-member-invite"]')
    return send
  }
  async function click(selector: string) {
    const element = document.querySelector(selector) as HTMLElement | null
    expect(element, selector).not.toBeNull()
    await act(async () => { element!.click() })
  }

  it('从来源会话同时选人和他人的 Agent，发邀请后重读名册', async () => {
    const send = await renderInvitation()
    expect(document.querySelector('[role="checkbox"][aria-label="自己"]')).toBeNull()
    expect(document.querySelector('[role="checkbox"][aria-label="已参与"]')).toBeNull()
    await click('[role="checkbox"][aria-label="同群成员"]')
    await click('[role="checkbox"][aria-label="别人的 Agent"]')
    await click('[data-testid="topic-member-invite-confirm"]')
    expect(send).toHaveBeenCalledWith('@同群成员 @别人的 Agent 邀请你们加入话题。', ['human-2', 'other-agent'], null)
    expect(getGroupCollab).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="topic-member-picker"]')).toBeNull()
  })

  it('邀请失败保留选择并允许重试，不把失败显示成已加入', async () => {
    const send = vi.fn(async () => {}).mockRejectedValueOnce(new Error('network unavailable'))
    await renderInvitation(send)
    await click('[role="checkbox"][aria-label="别人的 Agent"]')
    await click('[data-testid="topic-member-invite-confirm"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('邀请未完成')
    expect(document.querySelector('[role="checkbox"][aria-label="别人的 Agent"]')?.getAttribute('aria-checked')).toBe('true')
    expect(getGroupCollab).toHaveBeenCalledTimes(1)
    await click('[data-testid="topic-member-invite-confirm"]')
    expect(send).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="topic-member-picker"]')).toBeNull()
  })

  it('自己尚未参与也有邀请入口，邀请消息让自己和被点名的人入列', async () => {
    const send = await renderInvitation(undefined, false)
    getGroupCollab.mockResolvedValue({ snapshot: collab([], [humanItem('owner-1'), humanItem('human-2')]), identities: [] })
    await click('[role="checkbox"][aria-label="同群成员"]')
    await click('[data-testid="topic-member-invite-confirm"]')
    expect(send).toHaveBeenCalledWith('@同群成员 邀请你们加入话题。', ['human-2'], null)
    expect(getGroupCollab).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('[data-member-list-error="not-participant"]')).toBeNull()
  })

  it('发送中禁用提交与关闭，避免重复邀请', async () => {
    let finish!: () => void
    const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await renderInvitation(send)
    await click('[role="checkbox"][aria-label="同群成员"]')
    await click('[data-testid="topic-member-invite-confirm"]')
    const confirm = document.querySelector('[data-testid="topic-member-invite-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await act(async () => {
      confirm.click()
      confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="topic-member-picker"]')).not.toBeNull()
    await act(async () => { finish() })
    expect(document.querySelector('[data-testid="topic-member-picker"]')).toBeNull()
  })
})

describe('MemberListPanel —— agent 行的引擎/模型', () => {
  it('拿不到引擎/模型时那一格不渲染,❌ 不摆占位假值', async () => {
    await renderPanel(collab([agentItem('a1')]))
    const row = harness.container.querySelector('[data-member-row="a1"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.querySelector('[data-agent-meta="engine"]')).toBeNull()
    expect(row.querySelector('[data-agent-meta="model"]')).toBeNull()
    // 设备同理:identity.device_id 为空、devices 里也查不到 ⇒ 不显示。
    expect(row.querySelector('[data-agent-meta="device"]')).toBeNull()
    // 也不许用「未知 / — / 默认」这类看着正常的假值把空填上。
    for (const fake of ['未知', '默认', '—', 'N/A']) expect(row.textContent).not.toContain(fake)
  })

  it('正例:给得出值时这两格必须真的出现(否则上一条判据是死的)', async () => {
    await renderPanel(collab([agentItem('a1', { client: 'claude-code', model_source: 'opus-5' })]))
    const row = harness.container.querySelector('[data-member-row="a1"]') as HTMLElement
    expect(row.querySelector('[data-agent-meta="engine"]')?.textContent).toBe('claude-code')
    expect(row.querySelector('[data-agent-meta="model"]')?.textContent).toBe('opus-5')
  })

  it('client 恒为 null 的真实形状下,引擎从联系人档的 agent_type 兜住', async () => {
    await renderPanel(collab([agentItem('a1')]), [
      { id: 'a1', agent_type: 'claude-code' } as ContactUser,
    ])
    const row = harness.container.querySelector('[data-member-row="a1"]') as HTMLElement
    // 显示的是产品里那个名字(Claude),❌ 不是 agent_type 的机器值 claude-code。
    expect(row.querySelector('[data-agent-meta="engine"]')?.textContent).toBe('Claude')
  })

  it('联系人档只覆盖主人自己的 agent:别人的 agent 不在通讯录里,引擎那一格照样空着', async () => {
    await renderPanel(collab([agentItem('a1')]), [
      { id: 'someone-elses-agent', agent_type: 'codex' } as ContactUser,
    ])
    const row = harness.container.querySelector('[data-member-row="a1"]') as HTMLElement
    expect(row.querySelector('[data-agent-meta="engine"]')).toBeNull()
    expect(row.textContent).not.toContain('Codex')
  })


  it('人 / Agent 分两段,但整块只有一条滚动轴 —— 段内❌ 不自己限高', async () => {
    await renderPanel(collab([agentItem('a1')], [humanItem('owner-1', { role: 'owner' })]))
    expect(harness.container.querySelector('[data-member-section="human"] [data-member-row="owner-1"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-member-section="agent"] [data-member-row="a1"]')).toBeTruthy()
    // 段内限高 = 第二条滚动轴。6 个 agent 一共 468px 撞上 420px 的顶 ⇒ 最后一行被切掉半截,
    // 而外面那层还空着三百多像素(owner 2026-09-19 实测截图)。
    for (const kind of ['human', 'agent']) {
      const rows = harness.container.querySelector(`[data-member-section-rows="${kind}"]`) as HTMLElement
      expect(rows.style.maxHeight).toBe('')
      expect(rows.style.overflowY).toBe('')
    }
    // 阳控:滚动仍然有人负责 —— 面板自己那一层。少了这一格,上面两句用「整块都不能滚」也能过。
    const scroll = harness.container.querySelector('[data-member-list-scroll]') as HTMLElement
    expect(scroll.style.overflowY).toBe('auto')
  })
})

describe('AgentFloodSystemNotice —— 一键全撤', () => {
  const notice = () => createNode(AgentFloodSystemNotice, {
    messageId: 'msg-flood-1',
    content: '这个群里的 agent 到了 6 个,已把它们全部改为「点名才回」。',
  })

  it('台账已撤回时不再渲染撤回按钮', async () => {
    getAdjustment.mockResolvedValue({
      id: 'adj-1', chat_id: 'chat-1', message_id: 'msg-flood-1',
      agent_count: 6, changed_count: 4, undone_at: '2026-09-18T01:00:00.000Z',
    })
    await renderWithAppProviders(harness, notice(), { auth: { id: 'owner-1' } })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[data-testid="agent-flood-notice"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-testid="agent-flood-undo"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-flood-undone"]')?.textContent).toContain('已撤回')
  })

  it('正例:台账还在且没撤过时,撤回按钮必须在(否则上一条判据是死的)', async () => {
    getAdjustment.mockResolvedValue({
      id: 'adj-1', chat_id: 'chat-1', message_id: 'msg-flood-1',
      agent_count: 6, changed_count: 4, undone_at: null,
    })
    await renderWithAppProviders(harness, notice(), { auth: { id: 'owner-1' } })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[data-testid="agent-flood-undo"]')?.textContent).toBe('全部撤回')
  })

  it('没有台账(不是这条自动调档消息)时既没有按钮也没有「已撤回」', async () => {
    getAdjustment.mockResolvedValue(null)
    await renderWithAppProviders(harness, notice(), { auth: { id: 'owner-1' } })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[data-testid="agent-flood-undo"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-flood-undone"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// @@@5856 agent 数量线(owner 2026-09-19 的裁决:这个数放设置里,话题也生效、可自定义或跟随群)
// ---------------------------------------------------------------------------

const { parseAgentFloodThresholdDraft } = await import('../../../apps/desktop/src/components/chat/agentFloodThresholdModels')
const { AgentFloodThresholdSetting } = await import('../../../apps/desktop/src/components/chat/AgentFloodThresholdSetting')
const { GroupAgentFloodSettings } = await import('../../../apps/desktop/src/components/chat/GroupAgentFloodSettings')

function settingsRow(threshold: number | null, effective: number | null) {
  return {
    id: 'chat-1', public_id: 7, creator_user_id: 'owner-1', name: '话题', status: 'active' as const,
    group_prompt: null, default_agent_type: null, join_token: null, description: null,
    max_members: 100, allow_member_invite: false, invite_link_enabled: true, agent_join_approval: false,
    join_mode: 'approval' as const, hide_history: false, avatar_url: null, is_discoverable: false,
    agent_flood_threshold: threshold, agent_flood_threshold_effective: effective,
  }
}

async function renderThresholdSetting(threshold: number | null, effective: number | null) {
  const snapshot = collab([agentItem('a1')], [humanItem('owner-1', { role: 'owner' })])
  getGroupCollab.mockResolvedValue({ snapshot, identities: identitiesFor(snapshot) })
  getSettings.mockResolvedValue(settingsRow(threshold, effective))
  await renderWithAppProviders(
    harness,
    createNode(AgentFloodThresholdSetting, { chatId: 'chat-1', editable: true, inherits: true }),
    { auth: { id: 'owner-1' }, chat: { identitiesById: {} }, contacts: { contacts: [] } },
  )
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

const thresholdInput = () =>
  harness.container.querySelector('[data-testid="agent-flood-threshold-input"]') as HTMLInputElement | null

/** 在输入框里敲一个值再失焦 —— 与真人改这一格的路径一致(提交发生在 blur / 回车)。 */
async function typeThreshold(next: string) {
  const input = thresholdInput()!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // React 的 onBlur 挂的是**冒泡的** focusout;派一个不冒泡的 'blur' 过去它收不到,
  // 那时这一格永远绿(什么都没提交)。
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
}

describe('@@@5856 收一格数量线草稿', () => {
  it('空 = 交回去继承;整数 ≥1 = 这个数;其余一概不收', () => {
    expect(parseAgentFloodThresholdDraft('')).toBeNull()
    expect(parseAgentFloodThresholdDraft('   ')).toBeNull()
    expect(parseAgentFloodThresholdDraft('3')).toBe(3)
    expect(parseAgentFloodThresholdDraft(' 12 ')).toBe(12)
    // 0 / 负数 / 小数 / 文字都不是「一个数量线」—— 收下去会写出一条永远过线的规则。
    expect(parseAgentFloodThresholdDraft('0')).toBeUndefined()
    expect(parseAgentFloodThresholdDraft('-2')).toBeUndefined()
    expect(parseAgentFloodThresholdDraft('2.5')).toBeUndefined()
    expect(parseAgentFloodThresholdDraft('五')).toBeUndefined()
  })
})

describe('@@@5856 话题里的 agent 数量线', () => {
  it.each(['topic', 'group'] as const)('成员面板不再含阈值设置：%s', async (chatKind) => {
    const snapshot = collab([agentItem('a1')], [humanItem('owner-1', { role: 'owner' })])
    getGroupCollab.mockResolvedValue({ snapshot, identities: identitiesFor(snapshot) })
    await renderWithAppProviders(harness,
      createNode(MemberListPanel, { chatId: 'chat-1', chatKind, head }),
      { auth: { id: 'owner-1' } },
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[data-testid="member-list-search"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-testid="agent-flood-threshold-row"]')).toBeNull()
    expect(getSettings).not.toHaveBeenCalled()
  })

  it('没填自己的数时,占位符显示的是**服务端算出来的**生效值,❌ 不是客户端编的 5', async () => {
    // 群主把群的线改成了 9,话题没填 ⇒ 话题跟着走。客户端若自己写 COALESCE(…, 5) 这里就会是 5。
    await renderThresholdSetting(null, 9)
    expect(thresholdInput()?.value).toBe('')
    expect(thresholdInput()?.getAttribute('placeholder')).toBe('9')
    const row = harness.container.querySelector('[data-testid="agent-flood-threshold-row"]')
    expect(row?.getAttribute('data-agent-flood-effective')).toBe('9')
    expect(row?.textContent).toContain('跟随来源那条线')
  })

  it('填一个数就存这条线自己的值;清空 = 交回去跟随', async () => {
    await renderThresholdSetting(null, 9)
    updateSettings.mockResolvedValue(settingsRow(3, 3))
    await typeThreshold('3')
    expect(updateSettings).toHaveBeenCalledWith('chat-1', { agent_flood_threshold: 3 })

    updateSettings.mockResolvedValue(settingsRow(null, 9))
    await typeThreshold('')
    expect(updateSettings).toHaveBeenLastCalledWith('chat-1', { agent_flood_threshold: null })
  })

  it('收不下的输入原样还原,❌ 不落库也不留半截草稿', async () => {
    await renderThresholdSetting(4, 4)
    updateSettings.mockResolvedValue(settingsRow(4, 4))
    await typeThreshold('0')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(thresholdInput()?.value).toBe('4')
  })

  it('读不到生效值时整行不画 —— ❌ 不摆一个看着正常的默认数', async () => {
    await renderThresholdSetting(null, null)
    expect(harness.container.querySelector('[data-testid="agent-flood-threshold-row"]')).toBeNull()
  })
})


describe('#5999 群设置只管群自己的阈值，私聊设置管话题阈值', () => {
  const listTopics = vi.mocked(topicService.listTopicsOfChat)
  function seedSettings(role: 'owner' | 'admin' | 'member' | null = 'owner') {
    listTopics.mockResolvedValue([
      { chat_id: 'topic-1', name: '设计讨论', source_message_id: 'msg-1', creator_user_id: 'owner-1', last_message_at: null, message_count: 1, participant_count: 1, is_participant: role !== null },
      { chat_id: 'topic-2', name: '发布讨论', source_message_id: 'msg-2', creator_user_id: 'someone-else', last_message_at: null, message_count: 1, participant_count: 1, is_participant: false },
    ])
    const snapshot = collab([], role ? [humanItem('owner-1', { role })] : [])
    getGroupCollab.mockImplementation(async (id) => {
      if (id === 'topic-2' || !role) throw new GroupCollabEmptyError()
      return { snapshot, identities: identitiesFor(snapshot) }
    })
    const values = new Map<string, number | null>([['source-1', 9], ['topic-1', null], ['topic-2', 4]])
    const read = (id: string) => ({ ...settingsRow(values.get(id) ?? null, values.get(id) ?? values.get('source-1') ?? 5), id })
    getSettings.mockImplementation(async (id) => read(id))
    updateSettings.mockImplementation(async (id, patch) => {
      if (patch.agent_flood_threshold !== undefined) values.set(id, patch.agent_flood_threshold)
      return read(id)
    })
    return values
  }
  const toast = vi.fn()
  async function renderSettings(editable?: boolean, subscribeAccountRevision: ChatContextValue['subscribeAccountRevision'] = () => () => {}) {
    await renderWithAppProviders(harness, createNode(GroupAgentFloodSettings, { chatId: 'source-1', editable }), { auth: { id: 'owner-1' }, toast, chat: { subscribeAccountRevision } })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  }
  const inputs = () => Array.from(harness.container.querySelectorAll<HTMLInputElement>('[data-testid="agent-flood-threshold-input"]'))
  async function change(input: HTMLInputElement, next: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  }
  it('群设置只有群自己的阈值，不再列出话题', async () => {
    seedSettings()
    await renderSettings(true)
    expect(inputs()).toHaveLength(1)
    expect(harness.container.querySelector('select')).toBeNull()
    expect(harness.container.textContent).not.toContain('话题阈值')
    expect(listTopics).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalledWith('topic-1')
    await change(inputs()[0], '7')
    expect(updateSettings).toHaveBeenLastCalledWith('source-1', { agent_flood_threshold: 7 })
  })
  it('群阈值关闭重开仍从保存值读取', async () => {
    seedSettings()
    await renderSettings(true)
    await change(inputs()[0], '6')
    harness.cleanup(); harness = createReactHarness()
    await renderSettings(true)
    expect(inputs()[0].value).toBe('6')
  })
  it('普通 chat_changed 保留群阈值框的草稿、DOM 和焦点', async () => {
    const values = seedSettings()
    const listeners = new Set<AccountRevisionListener>()
    await renderSettings(true, (_event, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    const input = inputs()[0]
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    values.set('source-1', 7)
    await act(async () => {
      for (const listener of [...listeners]) await listener([{ revision: '1', event: 'chat_changed', payload: { chat_id: 'source-1' } }])
    })
    expect(inputs()[0]).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('12')
    expect(input.placeholder).toBe('7')
    expect(updateSettings).not.toHaveBeenCalled()
    await act(async () => { input.blur() })
    expect(updateSettings).toHaveBeenLastCalledWith('source-1', { agent_flood_threshold: 12 })
  })
  it('普通 chat_changed 保留私聊话题阈值框的草稿、DOM 和焦点', async () => {
    const values = seedSettings()
    const listeners = new Set<AccountRevisionListener>()
    await renderSettings(undefined, (_event, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    const input = inputs()[0]
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const topics = await topicService.listTopicsOfChat('source-1')
    let resolveTopics!: (value: typeof topics) => void
    listTopics.mockImplementationOnce(() => new Promise((resolve) => { resolveTopics = resolve }))
    values.set('source-1', 7)
    await act(async () => {
      for (const listener of [...listeners]) await listener([{ revision: '1', event: 'chat_changed', payload: { chat_id: 'source-1' } }])
    })
    expect(inputs()[0]).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('12')
    expect(input.placeholder).toBe('7')
    expect(updateSettings).not.toHaveBeenCalled()
    await act(async () => { resolveTopics(topics) })
    expect(inputs()[0]).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('12')
    await act(async () => { input.blur() })
    expect(updateSettings).toHaveBeenLastCalledWith('topic-1', { agent_flood_threshold: 12 })
  })
  it('没有本地草稿时 chat_changed 更新群阈值的权威值', async () => {
    const values = seedSettings()
    const listeners = new Set<AccountRevisionListener>()
    await renderSettings(true, (_event, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    values.set('source-1', 6)
    await act(async () => {
      for (const listener of [...listeners]) await listener([{ revision: '1', event: 'chat_changed', payload: { chat_id: 'source-1' } }])
    })
    expect(inputs()[0].value).toBe('6')
    expect(updateSettings).not.toHaveBeenCalled()
  })
  it('保存成功后不被晚到的后台读取覆盖', async () => {
    seedSettings()
    const listeners = new Set<AccountRevisionListener>()
    await renderSettings(true, (_event, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    const read = getSettings.getMockImplementation()!
    let resolveSettings!: (value: ReturnType<typeof settingsRow>) => void
    getSettings.mockImplementation((id) => id === 'source-1'
      ? new Promise((resolve) => { resolveSettings = resolve })
      : read(id))
    await act(async () => {
      for (const listener of [...listeners]) await listener([{ revision: '1', event: 'chat_changed', payload: { chat_id: 'source-1' } }])
    })
    await change(inputs()[0], '12')
    expect(inputs()[0].value).toBe('12')
    await act(async () => { resolveSettings(settingsRow(null, 9)) })
    expect(inputs()[0].value).toBe('12')
    expect(inputs()[0].placeholder).toBe('12')
  })
  it('普通成员只能读群阈值', async () => {
    seedSettings('member')
    await renderSettings(false)
    expect(inputs()).toHaveLength(0)
    expect(harness.container.querySelectorAll('[data-agent-flood-effective="9"]')).toHaveLength(1)
    expect(updateSettings).not.toHaveBeenCalled()
  })
  it('私聊里无法编辑未参与的话题，但能读取独立值', async () => {
    seedSettings()
    await renderSettings()
    const select = harness.container.querySelector('select')!
    await act(async () => { select.value = 'topic-2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(inputs()).toHaveLength(0)
    expect(harness.container.querySelector('[data-agent-flood-effective="4"]')).toBeTruthy()
    expect(updateSettings).not.toHaveBeenCalled()
  })
  it('私聊来源只列话题配置，不为单聊提供无效阈值', async () => {
    seedSettings('admin')
    await renderSettings()
    expect(listTopics).toHaveBeenCalledWith('source-1')
    expect(getSettings).not.toHaveBeenCalledWith('source-1')
    expect(inputs()).toHaveLength(1)
    await change(inputs()[0], '8')
    expect(updateSettings).toHaveBeenLastCalledWith('topic-1', { agent_flood_threshold: 8 })
  })
  it('权限读取失败时显示错误，不能用来源管理员身份代替话题权限', async () => {
    seedSettings()
    getGroupCollab.mockRejectedValue(new Error('network unavailable'))
    await renderSettings()
    expect(inputs()).toHaveLength(0)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('话题管理权限未能加载')
  })
  it('保存失败回到已保存值，且显示可见失败反馈', async () => {
    seedSettings()
    await renderSettings(true)
    updateSettings.mockRejectedValueOnce(new Error('permission denied'))
    await change(inputs()[0], '4')
    expect(inputs()[0].value).toBe('9')
    expect(inputs()[0].disabled).toBe(false)
    expect(toast).toHaveBeenCalledWith('阈值保存失败，请重试。', 'error')
  })
})
