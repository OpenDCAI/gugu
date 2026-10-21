// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

// #6428 表情回应条必须与气泡同侧。消息列是整列宽(70%/78%),气泡行 fit-content,我方靠 marginLeft:auto 贴右;
// 回应条也是整列宽的 flex,不显式靠右就留在整列最左 —— 对方消息看不出来(气泡本就在左),只有「别人给我点赞」错位。
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('MessageBubble reaction bar side (#6428)', () => {
  it.each([
    { isMine: true, side: 'end' },
    { isMine: false, side: 'start' },
  ])('isMine=$isMine → bubble and reactions both on the $side side', async ({ isMine, side }) => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({
        id: 'msg-1',
        is_mine: isMine,
        sender_user_id: isMine ? 'me' : 'peer-1',
        reactions: [{ emoji: '👍', count: 1, my_reaction: !isMine }],
      }),
      onReaction: vi.fn(),
      memberReadSeqs: {},
      onQuote: vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      isGroup: true,
    }))
    const row = harness.container.querySelector('[data-message-bubble-row="true"]') as HTMLElement | null
    const reactions = harness.container.querySelector('[data-message-reactions="true"]') as HTMLElement | null
    if (!row || !reactions) throw new Error('bubble row or reaction bar not rendered')
    expect(reactions.textContent).toContain('👍')
    const bubbleSide = row.style.marginLeft === 'auto' ? 'end' : 'start'
    const reactionSide = reactions.style.justifyContent === 'flex-end' ? 'end' : 'start'
    expect(bubbleSide).toBe(side)
    expect(reactionSide).toBe(bubbleSide)
  })
})
