// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { agentTurnFailureUserMessage } from '../../../../apps/desktop/src/lib/agentTurnFailure'

vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [{ id: 'agent-1', type: 'agent' }] }) }))
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({ AgentSettingsModal: ({ agent, initialTab }: { agent: { id: string }; initialTab: string }) => <div data-model-settings={agent.id} data-model-tab={initialTab} /> }))

vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({
  Avatar: () => <span data-avatar />
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  requeueErroredDeviceCommand: vi.fn(async () => false)
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => ({ failure: null, readFailed: false, dismiss: vi.fn(), retry: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentTurnFailure', () => ({
  useAgentTurnFailure: () => ({
    failure: { agentUserId: 'agent-1', commandId: 'command-1', at: 1, rawMessage: 'deliver failed' },
    dismiss: vi.fn(),
  }),
}))

import { AgentConversationNoticeSlot, AgentTurnFailureBar } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

import { requeueErroredDeviceCommand } from '../../../../apps/desktop/src/lib/supabase'
import { SystemMessageNotice } from '../../../../apps/desktop/src/components/chat/SystemMessageNotice'

const baseFailure = {
  agentUserId: 'agent-1',
  commandId: 'command-1',
  at: 1
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})

// #7103 同一次失败只说一次:起任务 / 恢复失败的横幅在说这次失败时,同槽位的回合失败条不再说一遍。
describe('AgentConversationNoticeSlot', () => {
  const props = { chatId: 'chat-1', threadRootId: null, profiles: {}, sessionpageNotices: <div data-banner /> }
  it('hides the turn failure bar while the session banner explains the failure', async () => {
    await harness.render(createNode(AgentConversationNoticeSlot, { ...props, failureExplained: true }))
    expect(harness.container.querySelector('[data-banner]')).not.toBeNull()
    expect(harness.container.querySelector('.tfc')).toBeNull()
  })
  it('[positive control] shows the bar when no banner explains the failure', async () => {
    await harness.render(createNode(AgentConversationNoticeSlot, { ...props, failureExplained: false }))
    expect(harness.container.querySelector('.tfc')).not.toBeNull()
  })
})

describe('AgentTurnFailureBar error details', () => {
  it('shows a weekly quota notification in context without exposing the provider payload', async () => {
    const rawMessage = "You've hit your weekly limit. Internal trace x123; resets October 21"
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, rawMessage }, displayName: '咕咕', avatar: null, onDismiss: vi.fn(), onOpenModel: vi.fn() }))
    expect(harness.container.querySelector('[role="status"]')?.textContent).toContain('周限额度不足')
    expect(harness.container.innerHTML).not.toContain('Internal trace')
    expect(harness.container.innerHTML).not.toContain('October 21')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-model"]')).not.toBeNull()
  })
  it('keeps the human summary visible without exposing raw errors in hover or accessibility text', async () => {
    const rawMessage =
      'stream disconnected before completion: stream closed before response.completed'
    await harness.render(
      createNode(AgentTurnFailureBar, {
        failure: { ...baseFailure, rawMessage },
        displayName: 'Gugu',
        avatar: null,
        onDismiss: vi.fn()
      })
    )

    const message = harness.container.querySelector('.tfc-reason')
    expect(message?.textContent).toBe(agentTurnFailureUserMessage(rawMessage))
    expect(message?.getAttribute('title')).toBeNull()
    expect(message?.getAttribute('aria-label')).toBe(
      agentTurnFailureUserMessage(rawMessage)
    )
  })

  it('does not create an empty tooltip when the raw error is blank', async () => {
    await harness.render(
      createNode(AgentTurnFailureBar, {
        failure: { ...baseFailure, rawMessage: '  ' },
        displayName: 'Gugu',
        avatar: null,
        onDismiss: vi.fn()
      })
    )

    const message = harness.container.querySelector('.tfc-reason')
    expect(message?.getAttribute('title')).toBeNull()
    expect(message?.getAttribute('aria-label')).toBe(agentTurnFailureUserMessage('  '))
  })
})


describe('model account quota', () => {
  it('explains the actual weekly limit and opens model selection instead of only saying generic failure', async () => {
    const onOpenModel = vi.fn()
    await harness.render(createNode(AgentTurnFailureBar, {
      failure: { ...baseFailure, rawMessage: "Internal error: You've hit your weekly limit · resets Oct 21 at 4am (Asia/Shanghai)" },
      displayName: 'Gugu', avatar: null, onDismiss: vi.fn(), onOpenModel,
    }))
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toContain('额度')
    harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-model"]')?.click()
    expect(onOpenModel).toHaveBeenCalledOnce()
  })
  it('does not label a network timeout as exhausted quota', () => {
    expect(agentTurnFailureUserMessage('request timed out')).not.toBe(agentTurnFailureUserMessage("You've hit your weekly limit"))
  })
  it('offers a model change when the gateway rejects a listed but unavailable model', async () => {
    await harness.render(createNode(AgentTurnFailureBar, {
      failure: { ...baseFailure, rawMessage: 'Internal error: API Error: 400 Model zoe/kimi-k3 is not available' },
      displayName: 'Gugu', avatar: null, onDismiss: vi.fn(), onOpenModel: vi.fn(),
    }))
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toContain('模型服务')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-model"]')).not.toBeNull()
  })
})


describe('durable provider failure notice', () => {
  const failureRow = (reason: string, content = 'English line for agents and old clients') => ({
    id: 'turn-failure:batch:fixture', content, content_type: 'system' as const, sender_user_id: 'agent-1',
    client_message_id: `turn-failure:turn-failure:batch:fixture:${reason}`,
  })
  it('额度/模型类的失败行不再渲染——由运行条那一排的 agent 状态位说（#7685）', async () => {
    for (const reason of ['weeklyQuota', 'monthlyQuota', 'quota', 'modelUnavailable']) {
      await harness.render(createNode(SystemMessageNotice, { senderName: 'Codex 1', message: failureRow(reason) }))
      expect(harness.container.textContent).toBe('')
    }
  })
  it('offers no model change for a reason another model would not get past', async () => {
    await harness.render(createNode(SystemMessageNotice, { senderName: 'Codex 1', message: failureRow('rateLimited') }))
    expect(harness.container.querySelector('.tfc-title')?.textContent).toBe('请求太频繁')
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toBe('请求过于频繁，请稍后重试。 · 下条消息会自动再试')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-retry"]')).toBeNull()
  })
  it('shows a row whose reason it cannot read (an old Chinese row, an unknown reason) as its plain content', async () => {
    for (const message of [{ ...failureRow('x', '周限额度不足'), client_message_id: 'turn-failure:batch:fixture' }, failureRow('notYetKnown')]) {
      await harness.render(createNode(SystemMessageNotice, { senderName: 'Codex 1', message }))
      expect(harness.container.textContent).toBe(message.content)
      expect(harness.container.querySelector('button')).toBeNull()
    }
  })
  it('keeps ordinary system messages in their existing presentation without model controls', async () => {
    await harness.render(createNode(SystemMessageNotice, { senderName: 'Codex 1', message: { id: 'ordinary-system', content: '群成员已加入', content_type: 'system', sender_user_id: null, client_message_id: null } }))
    expect(harness.container.textContent).toBe('群成员已加入')
    expect(harness.container.querySelector('button')).toBeNull()
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
  })
})


describe('topic-opened system notice', () => {
  const message = { id: 'notice-1', content: 'Codex 1 开了话题:Release: notes', content_type: 'system' as const,
    sender_user_id: 'agent-1', client_message_id: 'topic-opened:topic-chat-id' }
  it('opens the exact topic id through the anchor callback, keeping colons in its name', async () => {
    const onOpenTopic = vi.fn()
    await harness.render(createNode(SystemMessageNotice, { message, onOpenTopic }))
    const link = harness.container.querySelector<HTMLButtonElement>('[data-testid="topic-opened-link"]')!
    expect(link.textContent).toBe('Release: notes')
    expect(harness.container.textContent).toBe(message.content)
    await clickElement(link)
    expect(onOpenTopic).toHaveBeenCalledExactlyOnceWith('topic-chat-id')
  })
  it('does not infer a topic from matching words without the server marker or an opening path', async () => {
    for (const props of [
      { message: { ...message, client_message_id: null }, onOpenTopic: vi.fn() },
      { message: { ...message, content_type: 'text' as const }, onOpenTopic: vi.fn() },
      { message },
    ]) {
      await harness.render(createNode(SystemMessageNotice, props))
      expect(harness.container.textContent).toBe(message.content)
      expect(harness.container.querySelector('button')).toBeNull()
    }
  })
})


describe('shared failure card behavior', () => {
  const message = { id: 'failure', content: 'private host cause', content_type: 'system' as const,
    sender_user_id: 'agent-1', client_message_id: 'turn-failure:failure:network',
    turnFailure: { count: 3, recovered: true } }
  it('folds a recovered run and expands the same counted card without offering stream retry', async () => {
    await harness.render(createNode(SystemMessageNotice, { message, senderName: 'Codex' }))
    const summary = harness.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!
    expect(summary.textContent).toBe('Codex 之前 3 次没有完成 · 已恢复')
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
    await clickElement(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(harness.container.querySelector('.tfc-count')?.textContent).toBe('×3')
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toBe('与模型服务的连接中断，本次回复未完成。 · 下条消息会自动再试')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-retry"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('private host cause')
  })
  it('retries the existing failed command and dismisses only after requeue succeeds', async () => {
    const onDismiss = vi.fn()
    vi.mocked(requeueErroredDeviceCommand).mockResolvedValueOnce(true)
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, rawMessage: 'fetch failed' },
      displayName: 'Codex', avatar: null, onDismiss }))
    expect(onDismiss).not.toHaveBeenCalled()
    await clickElement(harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-retry"]')!)
    expect(requeueErroredDeviceCommand).toHaveBeenLastCalledWith('command-1')
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('keeps a failed requeue visible and enables retry again', async () => {
    const onDismiss = vi.fn()
    vi.mocked(requeueErroredDeviceCommand).mockRejectedValueOnce(new Error('offline'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, rawMessage: 'fetch failed' },
      displayName: 'Codex', avatar: null, onDismiss }))
    await clickElement(harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-retry"]')!)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-retry"]')?.disabled).toBe(false)
    errorLog.mockRestore()
  })
})
