// @vitest-environment jsdom
// #7685 额度/模型类失败 = agent 的安静的状态位，❌ 输入框上方的失败条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const toast = vi.hoisted(() => vi.fn())
const stored = vi.hoisted(() => ({ rawMessage: "You've hit your weekly limit" }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [{ id: 'agent-1', type: 'agent' }] }) }))
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({ AgentSettingsModal: () => <div data-model-settings /> }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span data-avatar /> }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ requeueErroredDeviceCommand: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: toast }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentTurnFailure', () => ({ useAgentTurnFailure: () => ({ failure: null, dismiss: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({
  useStoredAgentTurnFailure: () => ({
    failure: { agentUserId: 'agent-1', commandId: 'cmd-1', at: 1, rawMessage: stored.rawMessage, revision: 'r' },
    readFailed: false, dismiss: vi.fn(), retry: vi.fn(),
  }),
}))
import { AgentTurnFailureSlot } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

let ui: ReturnType<typeof createReactHarness>
const props = { chatId: 'chat-1', threadRootId: null, profiles: { 'agent-1': { displayName: 'Codex 114' } } }
beforeEach(() => { ui = createReactHarness(); toast.mockClear(); stored.rawMessage = "You've hit your weekly limit" })
afterEach(() => ui.cleanup())

describe('额度失败是状态位，不是失败条', () => {
  it('显示 agent 状态位、不出失败条或 toast', async () => {
    await ui.render(createNode(AgentTurnFailureSlot, props))
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')?.textContent).toContain('周限额度已满')
    expect(ui.container.querySelector('[data-testid="agent-turn-failure"]')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
    ui.cleanup(); ui = createReactHarness(); await ui.render(createNode(AgentTurnFailureSlot, props))
    expect(toast).not.toHaveBeenCalled()
  })
  it('[阳控] 非额度失败仍是失败条、不弹 toast', async () => {
    stored.rawMessage = 'HTTP 429 too many requests'
    await ui.render(createNode(AgentTurnFailureSlot, props))
    expect(ui.container.querySelector('[data-testid="agent-turn-failure"]')).not.toBeNull()
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })
})
