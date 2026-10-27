// @vitest-environment jsdom
// 项目里的 agent 就是一条会话:资料卡「发消息」打开的是它的会话(这台电脑或连着的哪台机器上的,会话页那棵树经
// project-group-chats 桥告诉聊天页),❌ 另开一个空私聊。不是任何机器上的会话的 agent / 人:照旧开私聊。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemberProfileCard, type MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

// 连着的另一台机器上的项目里的会话(会话页按 projectId 认它在哪台机器上)。
const onLinux1 = { projectId: 'project-on-linux-1', sessionId: 'conversation-on-linux-1' }
// 渲染者是 testHarness 的 user-1。
const agent: MemberProfileCardModel = { id: 'a-mine', displayName: 'Claude 202', avatar: null, email: null, type: 'agent',
  ownerUserId: 'user-1', role: 'member', membership: 'current', profileScope: 'group' }

describe('profile card「发消息」on an agent that is a session', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => {
    harness.cleanup()
    publishProjectGroupChats([], new Map(), new Map())
  })

  async function send(model: MemberProfileCardModel) {
    const onOpenChat = vi.fn()
    await renderWithAppProviders(harness, createNode(MemberProfileCard, { member: model, onOpenChat }), { chat: {}, contacts: {} })
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="member-profile-send-message-button"]')!)
    return onOpenChat.mock.calls[0]?.[0]
  }

  it('hands over the agent’s session (on this computer or another machine), so its session page opens', async () => {
    publishProjectGroupChats([], new Map(), new Map([['a-mine', onLinux1]]))
    expect(await send(agent)).toEqual(expect.objectContaining({ id: 'a-mine', session: onLinux1 }))
  })

  it('an agent that is no session anywhere still opens the chat', async () => {
    publishProjectGroupChats([], new Map(), new Map([['someone-else', onLinux1]]))
    expect((await send(agent))?.session).toBeUndefined()
  })

  it('a person still opens the chat, even if an id collides', async () => {
    publishProjectGroupChats([], new Map(), new Map([['u-a', onLinux1]]))
    expect((await send({ ...agent, id: 'u-a', type: 'human', ownerUserId: undefined }))?.session).toBeUndefined()
  })
})
