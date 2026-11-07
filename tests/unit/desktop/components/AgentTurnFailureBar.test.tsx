// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [{ id: 'agent-1', type: 'agent' }] }) }))
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({ AgentSettingsModal: ({ agent, initialTab }: { agent: { id: string }; initialTab: string }) => <div data-model-settings={agent.id} data-model-tab={initialTab} /> }))

vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({
  Avatar: () => <span data-avatar />
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  requeueErroredDeviceCommand: vi.fn(async () => false)
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => ({
  failure: { agentUserId: 'agent-1', commandId: 'command-1', at: 1, reason: 'generic', revision: 'r1' },
  dismiss: vi.fn(),
}) }))

import { AgentConversationNoticeSlot, AgentFailureSlotHost, AgentTurnFailureBar } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'
import { installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'

import { requeueErroredDeviceCommand } from '../../../../apps/desktop/src/lib/supabase'
import { SystemMessageNotice } from '../../../../apps/desktop/src/components/chat/SystemMessageNotice'

const baseFailure = {
  agentUserId: 'agent-1',
  commandId: 'command-1',
  at: 1,
  reason: 'generic' as const,
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

// #1264 评审②: the task page has no chat composer; its slot gets the same bar for its agent, from the same rows.
describe('AgentFailureSlotHost', () => {
  it('draws the agent\'s failure into that agent\'s task-page slot, and nothing for an agent it does not know', async () => {
    installShellSlots()
    const mine = document.body.appendChild(document.createElement('div'))
    const unknown = document.body.appendChild(document.createElement('div'))
    readShellSlots()!.setSlot('agent-failure:agent-1', mine)
    readShellSlots()!.setSlot('agent-failure:someone-else', unknown)
    try {
      await harness.render(createNode(AgentFailureSlotHost, {}))
      expect(mine.querySelector('[data-testid="agent-turn-failure"]')).not.toBeNull()
      expect(unknown.childElementCount).toBe(0)
    } finally {
      readShellSlots()!.setSlot('agent-failure:agent-1', null)
      readShellSlots()!.setSlot('agent-failure:someone-else', null)
      mine.remove(); unknown.remove()
    }
  })
})

// The renderer never sees the raw error (the command row is read without it): it says the reason the host recorded.
describe('AgentTurnFailureBar reason', () => {
  it('says a weekly limit and offers a model change', async () => {
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, reason: 'weeklyQuota' }, displayName: '咕咕', avatar: null, onDismiss: vi.fn(), onOpenModel: vi.fn() }))
    expect(harness.container.querySelector('[role="status"]')?.textContent).toContain('周限额度不足')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-model"]')).not.toBeNull()
  })
  it('offers a model change when the model is unavailable', async () => {
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, reason: 'modelUnavailable' }, displayName: 'Gugu', avatar: null, onDismiss: vi.fn(), onOpenModel: vi.fn() }))
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toContain('模型服务')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-model"]')).not.toBeNull()
  })
  it('says an undelivered message without a retry that would resend it to nobody', async () => {
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, reason: 'undelivered' }, displayName: 'Gugu', avatar: null, onDismiss: vi.fn() }))
    expect(harness.container.querySelector('.tfc-title')?.textContent).toBe('所在实例未运行、未送达')
    expect(harness.container.querySelector('.tfc-reason')?.textContent).toContain('没有运行中的咕咕实例')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-retry"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-dismiss"]')).not.toBeNull()
  })
  it('[positive control] a generic failure offers retry', async () => {
    await harness.render(createNode(AgentTurnFailureBar, { failure: baseFailure, displayName: 'Gugu', avatar: null, onDismiss: vi.fn() }))
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-retry"]')).not.toBeNull()
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
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, reason: 'network' },
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
    await harness.render(createNode(AgentTurnFailureBar, { failure: { ...baseFailure, reason: 'network' },
      displayName: 'Codex', avatar: null, onDismiss }))
    await clickElement(harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-retry"]')!)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-turn-failure-retry"]')?.disabled).toBe(false)
    errorLog.mockRestore()
  })
})
