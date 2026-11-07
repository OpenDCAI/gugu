// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const stored = vi.hoisted(() => ({
  failure: null as null | { agentUserId: string; commandId: string; at: number; reason: 'generic'; revision: string },
  dismiss: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => stored }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [{ id: 'agent', type: 'agent' }] }) }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span data-avatar /> }))
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({ AgentSettingsModal: () => null }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ requeueErroredDeviceCommand: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
import { AgentTurnFailureSlot } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

let ui: ReturnType<typeof createReactHarness>
const props = { chatId: 'chat', threadRootId: null, profiles: { agent: { displayName: 'Test Agent' } } }
beforeEach(() => { ui = createReactHarness(); stored.failure = null })
afterEach(() => ui.cleanup())

it('does not add a warning, a retry button or a notice row when background status reads fail', async () => {
  await ui.render(createNode(AgentTurnFailureSlot, props))
  expect(ui.container.childElementCount).toBe(0)
})

it('still displays a verified turn failure and its real delivery retry action while a read fails', async () => {
  stored.failure = { agentUserId: 'agent', commandId: 'cmd', at: 1, reason: 'generic', revision: 'one' }
  await ui.render(createNode(AgentTurnFailureSlot, props))
  expect(ui.container.querySelector('[data-testid="agent-turn-failure"]')).not.toBeNull()
  expect(ui.container.querySelector('[data-testid="agent-turn-failure-retry"]')).not.toBeNull()
})
