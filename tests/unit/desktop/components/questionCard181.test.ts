// @vitest-environment jsdom
// gugu-dev#181 ⑨ 问题卡在群里:问我的,选项能点(点了 = 引用卡回一句选项名)、一行状态读会话结算 ——
// 待你回答 / 已回答：X(选项变灰)/ 这次提问已结束;不是问我的(同事),只有问题和灰着的选项,不去读谁的会话。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { QuestionCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const send = vi.fn(async () => 'reply-1')
let viewer = 'owner-1'
let settlement: Record<string, unknown> | null = null
const reads: Array<{ enabled: boolean; deviceId: string | null }> = []

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'claude' }))
vi.mock('../../../../apps/desktop/src/store/auth', async (original) => ({ ...await original<object>(), useAuth: () => ({ user: { id: viewer } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', async (original) => ({
  ...await original<object>(), useDevicesStore: () => ({ devices: viewer === 'owner-1' ? [{ device_id: 'device-1', is_current_device: true }] : [] }),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', async (original) => ({ ...await original<object>(), useChatStore: () => ({ sendMessageToChat: send }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({
  useTimelineSession: (_client: unknown, _by: string, deviceId: string | null, _session: string | null, enabled: boolean) => {
    reads.push({ enabled, deviceId })
    return { timeline: { settlements: enabled && settlement ? { 'agent-question:q1': settlement } : {} } }
  },
}))

const { QuestionCardView } = await import('../../../../apps/desktop/src/components/chat/QuestionCardView')

const CARD: QuestionCard = {
  v: 1, type: 'question', text: '要把初始化提前到登录之前吗？', options: ['提前', '先不动'], ownerUserId: 'owner-1',
  questionId: 'agent-question:q1', sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'Mac',
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); viewer = 'owner-1'; settlement = null; reads.length = 0; send.mockClear() })
afterEach(() => { harness.cleanup() })

const render = (card: QuestionCard = CARD) => renderWithAppProviders(harness, createNode(QuestionCardView, { card, chatId: 'group-1', messageId: 'card-msg', agentUserId: 'agent-7', time: '10:21' }))
const options = () => [...harness.container.querySelectorAll('button')].filter((button) => CARD.options.includes(button.textContent ?? ''))

describe('question card in a group (gugu-dev#181 ⑨)', () => {
  it('asked of me and waiting: a pick replies to the card with the choice', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render()
    expect(harness.container.textContent).toContain('要把初始化提前到登录之前吗？')
    expect(harness.container.textContent).toContain('待你回答')
    expect(options().every((button) => !button.disabled)).toBe(true)
    await act(async () => { options()[0]!.click() })
    expect(send).toHaveBeenCalledWith('group-1', '提前', { replyToMessageId: 'card-msg' })
  })

  it('answered: says what, and the choices go grey', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'resolved', optionId: JSON.stringify([{ selected: ['先不动'] }]) }
    await render()
    expect(harness.container.textContent).toContain('已回答：先不动')
    expect(options().every((button) => button.disabled)).toBe(true)
  })

  it('withdrawn: the question has closed', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'cancelled', optionId: null }
    await render()
    expect(harness.container.textContent).toContain('这次提问已结束')
  })

  it('a colleague sees the question and its choices, greyed, and nobody\'s session is read', async () => {
    viewer = 'colleague-1'
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render()
    expect(options().every((button) => button.disabled)).toBe(true)
    expect(harness.container.textContent).not.toContain('待你回答')
    expect(reads.every((read) => !read.enabled)).toBe(true)
  })

  it('several parts: no choices on the card, it is answered in the task', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render({ ...CARD, options: [] })
    expect(harness.container.textContent).toContain('到任务里回答')
    expect(harness.container.querySelector('[data-testid="composer-card"]')!.tagName).toBe('BUTTON')
  })
})
