// @vitest-environment jsdom
// #709 把引用块那一面抽成 MessageQuoteFrame,示例项目里 agent 回群时引它那张任务卡也画这一面。群里真引用的样子一点不变:
// 下面每一种引用的整段 DOM 都对着抽之前的组件录下的快照。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageQuote } from '../../../../apps/desktop/src/components/chat/MessageQuote'
import type { MessageItem } from '../../../../packages/core/src/shared/types/chat'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const CARD = JSON.stringify({
  v: 1, type: 'task', text: '想找个周末去趟杭州，日子还没定', agentUserId: 'agent-1', agentName: 'Codex 6', agentType: 'codex',
  sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'This computer',
})
const members = { 'owner-1': { displayName: 'Ana' } } as unknown as Record<string, MemberProfileCardModel>

function message(overrides: Partial<MessageItem>): MessageItem {
  return { id: 'm2', chat_id: 'chat-1', sender_user_id: 'agent-1', content: 'ok', is_mine: false, reply_to_message_id: 'm1', reply_to_sender_user_id: 'owner-1', reply_to_content: 'hello', ...overrides } as MessageItem
}

async function markup(msg: MessageItem, props: { quoterIsAgent?: boolean; onShowMessage?: (id: string) => void } = {}) {
  await renderWithAppProviders(harness, createNode(MessageQuote, { msg, quoterIsAgent: props.quoterIsAgent ?? false, memberProfiles: members, onShowMessage: props.onShowMessage }))
  await act(async () => { await Promise.resolve() })
  return harness.container.innerHTML
}

describe('reply quote face is unchanged by the extraction (#709)', () => {
  it('an agent quoting its own task card', async () => {
    expect(await markup(message({ reply_to_content: CARD }), { quoterIsAgent: true })).toMatchSnapshot()
  })

  it('a person quoting a task card', async () => {
    expect(await markup(message({ reply_to_content: CARD, sender_user_id: 'owner-2' }))).toMatchSnapshot()
  })

  it('quoting what someone said, in my own bubble', async () => {
    expect(await markup(message({ is_mine: true, sender_user_id: 'owner-1' }))).toMatchSnapshot()
  })

  it('a quote that jumps to the quoted message', async () => {
    expect(await markup(message({}), { onShowMessage: () => {} })).toMatchSnapshot()
  })
})
