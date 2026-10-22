// @vitest-environment jsdom
// gugu-dev#181 任务卡在群里的样子:卡头带时刻,「交给」带头像,我自己这台电脑上的卡不写在哪个项目,不挂已读环;
// agent 回群引用那张卡时,引用块是卡头「新任务」+ 原话,不是「发卡的人 / 新任务：原话」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { serializeComposerCard, type TaskCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const CARD: TaskCard = {
  v: 1, type: 'task', text: '用一句话介绍你自己', agentUserId: 'agent-1', agentName: 'Codex 1',
  sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'This computer',
}
const bubble = (msg: ReturnType<typeof message>) => createNode(MessageBubble, {
  msg, onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  showReadReceipt: true, readReceiptRead: 0, readReceiptTotal: 1,
})
const ring = () => harness.container.querySelector('[data-testid="message-read-receipt"]')

describe('task card in a chat (gugu-dev#181)', () => {
  it('shows three rows with the time and the agent avatar, and no read ring', async () => {
    await renderWithAppProviders(harness, bubble(message({
      id: 'card-1', is_mine: true, content_type: 'card', content: serializeComposerCard(CARD), created_at: '2026-10-22T15:26:00.000Z',
    })))
    const card = harness.container.querySelector('[data-testid="composer-card"]')!
    expect(card.textContent).toContain('新任务')
    expect(card.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(card.textContent).toContain('Codex 1')
    expect(card.querySelector('[data-agent-harness]'), 'the card head is the agent engine mark').not.toBeNull()
    expect(card.textContent).not.toContain('project-1')
    expect(ring(), 'a task card is an event, not a line to read').toBeNull()
  })

  it('positive control: my plain message keeps its read ring', async () => {
    await renderWithAppProviders(harness, bubble(message({ id: 'text-1', is_mine: true, content: 'hi' })))
    expect(ring()).not.toBeNull()
  })

  it('quotes a card as its head and words, not as its sender', async () => {
    await renderWithAppProviders(harness, bubble(message({
      id: 'reply-1', is_mine: false, sender_user_id: 'agent-1', content: '我是 Codex',
      reply_to_message_id: 'card-1', reply_to_sender_user_id: 'owner', reply_to_content: serializeComposerCard(CARD),
    })))
    const quote = harness.container.querySelector('[title="跳到被引用的消息"]')!
    expect(quote.textContent).toContain('新任务')
    expect(quote.textContent).toContain('用一句话介绍你自己')
    expect(quote.textContent).not.toContain('新任务：')
  })
})
