// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

const stored = vi.hoisted(() => ({ dismiss: vi.fn(), failure: null as null | Record<string, unknown> }))
const notices = vi.hoisted(() => ({ notify: vi.fn(), dismissNotice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => notices)
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => stored }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [] }) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ requeueErroredDeviceCommand: vi.fn(), getCurrentAuthUserId: async () => null, chatDb: {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))

import { AgentTurnFailureSlot } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

let ui: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { ui?.cleanup(); stored.failure = null; vi.restoreAllMocks() })

describe('model unavailable status dismissal', () => {
  const render = async () => {
    ui?.cleanup()
    ui = createReactHarness()
    await ui.render(createNode(AgentTurnFailureSlot, { chatId: 'chat', threadRootId: null, profiles: { agent: { displayName: 'Codex' } } }))
  }
  it('shows the recorded model reason as the agent state and closes it through the command dismissal', async () => {
    await render()
    expect(ui!.container.querySelector('[data-testid="agent-quota-status"]')).toBeNull()
    stored.failure = { agentUserId: 'agent', commandId: 'cmd-1', reason: 'modelUnavailable', at: 1, revision: 'r1' }
    await render()
    expect(ui!.container.querySelector('[data-testid="agent-quota-status"]')?.textContent).toContain('模型不可用')
    await clickElement(ui!.container.querySelector<HTMLButtonElement>('[data-testid="agent-quota-dismiss"]')!)
    expect(stored.dismiss).toHaveBeenLastCalledWith('cmd-1')
    expect(notices.notify).not.toHaveBeenCalled()
    expect(notices.dismissNotice).not.toHaveBeenCalled()
  })
  it('[positive control] a reason another model would not get past is a failure card, not the agent state', async () => {
    stored.failure = { agentUserId: 'agent', commandId: 'cmd-2', reason: 'rateLimited', at: 1, revision: 'r1' }
    await render()
    expect(ui!.container.querySelector('[data-testid="agent-quota-status"]')).toBeNull()
    expect(ui!.container.querySelector('[data-testid="agent-turn-failure"]')).not.toBeNull()
  })
})
