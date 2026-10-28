// @vitest-environment jsdom
// #691 owner 10-28:私聊统一以后,手机私聊页头的「在任务中打开」去掉 —— 私聊本身就是任务页那个转录。
import { expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { presentationOfDisplayStatus } from '../../../support/agentDisplayStatusTestDouble'

vi.mock('../../../../apps/desktop/src/hooks/useSessionpageAgentProjection', () => ({
  useSessionpageAgentProjection: () => ({ kind: 'unmapped', error: null, context: null, agentUserId: 'agent-1' }),
}))
// 手机的会话目录里找得到这个 agent 的会话 —— 以前正是这时页头放那颗按钮。
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/useAgentSessionRow', () => ({
  useAgentSessionRow: () => ({ deviceId: 'device-1', session: { conversationId: 'conversation-1' } }),
}))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
import { useAgentSessionpagePresentation } from '../../../../apps/desktop/src/components/chat/AgentSessionpagePresentation'

const chat = {
  id: 'chat-agent', kind: 'ai', status: 'active', name: '', peer_user_id: 'agent-1', created_at: '',
  last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null,
  last_read_seq: 0, next_message_seq: 1,
} satisfies ChatItem

function Probe() {
  const { openAction } = useAgentSessionpagePresentation(
    chat,
    { display_name: 'Claude 9', avatar: null },
    { status: 'idle', presentation: presentationOfDisplayStatus('idle'), runningActivity: null, local: null },
    true,
    undefined,
    undefined,
  )
  return createNode('div', { 'data-testid': 'probe' }, openAction)
}

it('手机私聊页头没有「在任务中打开」,即使找得到这个 agent 的会话', async () => {
  const harness = createReactHarness()
  try {
    await harness.render(createNode(Probe, {}))
    expect(harness.container.querySelector('[data-testid="agent-open-task"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="probe"]')?.childElementCount).toBe(0)
  } finally {
    harness.cleanup()
  }
})
