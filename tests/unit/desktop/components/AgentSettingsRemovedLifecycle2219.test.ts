// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSettingsModal } from '../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal'
import {
  clearAgentDisplayStatusOverrides,
  setAgentDisplayStatusOverride,
} from '../../../support/agentDisplayStatusTestDouble'
import {
  clickElement,
  contact,
  createNode,
  createReactHarness,
  renderWithAppProviders,
  waitForCondition,
} from '../../../support/testHarness'
vi.mock(
  '../../../../apps/desktop/src/hooks/useAgentDisplayStatus',
  () => import('../../../support/agentDisplayStatusTestDouble'),
)
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  clearAgentDisplayStatusOverrides()
  harness.cleanup()
})
const ownedAgent = contact({
  id: 'agent-1',
  display_name: 'Lifecycle Agent',
  type: 'agent',
  owner_user_id: 'owner-1',
})
describe('AgentSettingsModal removed lifecycle boundary (#2219)', () => {
  it('closes the settings container immediately after deletion succeeds', async () => {
    const removeOwnedAgent = vi.fn(async () => {})
    const onClose = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(AgentSettingsModal, { agent: ownedAgent, onClose }),
      {
        auth: { id: 'owner-1' },
        contacts: { removeOwnedAgent },
      },
    )
    const deleteButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '删除 Agent',
    ) as HTMLButtonElement | undefined
    expect(deleteButton, 'active owned agent exposes the real settings delete path').toBeTruthy()
    await clickElement(deleteButton!)
    await waitForCondition(() => removeOwnedAgent.mock.calls.length === 1, 'agent deletion should finish')
    expect(onClose, 'successful deletion must exit the live settings container').toHaveBeenCalledOnce()
  })
  it('does not mount live settings panes once presence is removed', async () => {
    setAgentDisplayStatusOverride(ownedAgent.id, 'removed')
    const onClose = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(AgentSettingsModal, { agent: ownedAgent, onClose }),
      { auth: { id: 'owner-1' }, contacts: {} },
    )
    await waitForCondition(() => onClose.mock.calls.length === 1, 'removed lifecycle should close its stale opener')
    expect(document.body.querySelector('[data-testid="agent-settings-modal"]')).toBeNull()
    expect(document.body.textContent).not.toContain('定时任务')
    expect(document.body.textContent).not.toContain('聊天记录')
    expect(document.body.textContent).not.toContain('分享')
  })
})
