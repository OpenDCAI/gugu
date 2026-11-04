// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('ContactsPanel shared-group Agent cloud projection', () => {
  it('renders another user\'s Agent in cloud and opens the common group without DM or selection actions', async () => {
    const onOpenGroupChat = vi.fn()
    const onSwitchToChat = vi.fn()
    const sharedAgent = contact({
      id: 'shared-agent', type: 'agent', display_name: 'Shared Agent',
      owner_user_id: 'other-owner', device_id: 'their-device', agent_public: true,
    })
    const sharedGroup = {
      id: 'shared-group', kind: 'group' as const, name: 'Owner + Agent + Me', avatar_url: null,
      member_count: 3, is_muted: false, member_user_ids: ['owner-1', 'other-owner', sharedAgent.id],
    }
    await renderWithAppProviders(harness, createNode(ContactsPanel, { onOpenGroupChat, onSwitchToChat }), { shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { sharedGroupAgents: [sharedAgent], groupChats: [sharedGroup] },
      chat: { chats: [] },
    })

    const cloud = harness.container.querySelector('[data-device-scope="cloud"]')
    const row = cloud?.querySelector('[data-contact-id="shared-agent"]') as HTMLElement | null
    expect(row).toBeTruthy()
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.contactsSelectModeButton}"]`) as HTMLElement)
    expect(harness.container.querySelector('[data-contact-id="shared-agent"]')?.hasAttribute('data-contact-option')).toBe(false)
    await clickElement(row!)
    const openGroup = harness.container.querySelector('[data-testid="contact-shared-agent-primary-action"]') as HTMLButtonElement | null
    expect(openGroup?.textContent).toContain('打开群聊')
    expect(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}"]`)).toBeNull()
    expect(onSwitchToChat).not.toHaveBeenCalled()
    await clickElement(openGroup!)
    expect(onOpenGroupChat).toHaveBeenCalledWith(sharedGroup)
  })
})
