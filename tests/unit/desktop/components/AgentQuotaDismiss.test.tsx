// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

const stored = vi.hoisted(() => ({ dismiss: vi.fn(), retry: vi.fn() }))
const notices = vi.hoisted(() => ({ notify: vi.fn(), dismissNotice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => notices)
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => ({ ...stored, failure: null, readFailed: false }) }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [] }) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ requeueErroredDeviceCommand: vi.fn(), getCurrentAuthUserId: async () => null, chatDb: {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))

import { AgentTurnFailureSlot } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

let ui: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { ui?.cleanup(); vi.restoreAllMocks() })

describe('model unavailable status dismissal', () => {
  it('closes the inline status through the existing dismissal, then shows a new failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ui = createReactHarness()
    await ui.render(createNode(AgentTurnFailureSlot, { chatId: 'chat', threadRootId: null, profiles: { agent: { displayName: 'Codex' } } }))
    const fail = (commandId: string) => act(async () => {
      window.dispatchEvent(new CustomEvent(UI_EVENTS.agentStream, { detail: { conversationId: 'chat', agentUserId: 'agent',
        event: { type: 'error', commandId, message: 'Model test is not available' } } }))
    })
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')).toBeNull()
    await fail('cmd-1')
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')?.textContent).toContain('模型不可用')
    await clickElement(ui.container.querySelector<HTMLButtonElement>('[data-testid="agent-quota-dismiss"]')!)
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')).toBeNull()
    expect(stored.dismiss).toHaveBeenLastCalledWith('cmd-1')
    expect(notices.notify).not.toHaveBeenCalled()
    expect(notices.dismissNotice).not.toHaveBeenCalled()
    await fail('cmd-2')
    expect(ui.container.querySelector('[data-testid="agent-quota-status"]')).not.toBeNull()
    expect(ui.container.querySelector('[data-testid="agent-quota-dismiss"]')).not.toBeNull()
  })
})
