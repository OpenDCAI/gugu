// @vitest-environment jsdom
// #6832 别人的 agent 不能私聊 ⇒ 它的资料卡上不画能点的「发消息」(通讯录早就这么做,见 ContactsPanel 的
// isOwnedAgent、ContactsIndex 的 isAnotherUsersAgent)。人照旧有;自己的 agent 有,打开的是它的会话(#622,没有会话就不画,
// 见 memberProfileCardAgentSession);悄悄话是群内的,不受影响。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemberProfileCard, type MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

// 渲染者是 testHarness 的 user-1。
const member = (overrides: Partial<MemberProfileCardModel>): MemberProfileCardModel => ({
  id: 'm-1', displayName: 'Someone', avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'group', ...overrides,
})

describe('#6832 profile card offers「发消息」only where a DM can open', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => {
    harness.cleanup()
    publishProjectGroupChats([], new Map(), new Map())
  })

  async function render(model: MemberProfileCardModel) {
    const onOpenChat = vi.fn()
    const onWhisper = vi.fn()
    await renderWithAppProviders(harness, createNode(MemberProfileCard, { member: model, onOpenChat, onWhisper }), { chat: {}, contacts: {} })
    const send = harness.container.querySelector<HTMLElement>('[data-testid="member-profile-send-message-button"]')
    return { send, onOpenChat, text: harness.container.textContent ?? '' }
  }

  it('a person: the button is there and opens the chat', async () => {
    const { send, onOpenChat } = await render(member({ id: 'u-a', displayName: 'Alice' }))
    expect(send).not.toBeNull()
    await clickElement(send!)
    expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-a' }))
  })

  it('my own agent: the button is there', async () => {
    publishProjectGroupChats([], new Map(), new Map([['a-mine', { projectId: 'p-1', sessionId: 's-1' }]]))
    const { send } = await render(member({ id: 'a-mine', displayName: 'Claude 1', type: 'agent', ownerUserId: 'user-1' }))
    expect(send).not.toBeNull()
  })

  it("someone else's agent: no「发消息」to click", async () => {
    const { send } = await render(member({ id: 'a-theirs', displayName: 'Codex 9', type: 'agent', ownerUserId: 'u-other' }))
    expect(send).toBeNull()
  })
})
