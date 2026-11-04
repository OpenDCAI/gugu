// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('ContactsPanel default section collapse', () => {
  it('counts folded device content and does not show an empty page while a device owns a group', async () => {
    const agent = contact({ id: 'local-agent', type: 'agent', owner_user_id: 'owner-1', device_id: 'local-device' })
    const group = { id: 'project-group', kind: 'group' as const, name: 'Project Group', avatar_url: null, member_count: 2, is_muted: false, member_user_ids: ['owner-1', agent.id] }
    await renderWithAppProviders(harness, createNode(ContactsPanel, {}), { shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { contacts: [agent], groupChats: [group] },
      chat: { chats: [] },
    })
    const section = harness.container.querySelector('[data-testid="contacts-device-section"]')!
    const heading = section.querySelector('[data-slot="section-label"]') as HTMLElement
    expect(heading.textContent).toContain('2')
    expect(section.querySelector('[data-slot="collapse-panel"]')?.hasAttribute('data-closed')).toBe(true)
    for (const id of [AUTOMATION_TEST_IDS.contactsPersonEmpty, AUTOMATION_TEST_IDS.contactsGroupEmpty, AUTOMATION_TEST_IDS.contactsAgentEmpty]) {
      expect(harness.container.querySelector('[data-testid="' + id + '"]')).toBeNull()
    }
    await clickElement(heading)
    expect(section.textContent).toContain('Project Group')
    await clickElement(heading)
    expect(heading.textContent).toContain('2')
    expect(harness.container.querySelector('[data-testid="' + AUTOMATION_TEST_IDS.contactsGroupEmpty + '"]')).toBeNull()
  })

  it('retains the empty states when all contact partitions are empty', async () => {
    await renderWithAppProviders(harness, createNode(ContactsPanel, {}), { shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { contacts: [], groupChats: [] },
      chat: { chats: [] },
    })
    expect(harness.container.querySelector('[data-testid="' + AUTOMATION_TEST_IDS.contactsPersonEmpty + '"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-testid="' + AUTOMATION_TEST_IDS.contactsGroupEmpty + '"]')).toBeTruthy()
  })

  it('opens People and Groups, folds device sections, and keeps that state across a search', async () => {
    const sharedAgent = contact({
      id: 'shared-agent', type: 'agent', display_name: 'Shared Agent',
      owner_user_id: 'other-owner', device_id: 'their-device', agent_public: true,
    })
    const group = {
      id: 'plain-group', kind: 'group' as const, name: 'Plain Group', avatar_url: null,
      member_count: 2, is_muted: false, member_user_ids: ['owner-1', 'alice'],
    }
    await renderWithAppProviders(harness, createNode(ContactsPanel, {}), { shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })], sharedGroupAgents: [sharedAgent], groupChats: [group] },
      chat: { chats: [] },
    })

    const panels = () => Array.from(harness.container.querySelectorAll('[data-slot="collapse-panel"]'))
    const devicePanels = () => panels().filter((p) => p.closest('[data-testid="contacts-device-section"]'))
    const otherPanels = () => panels().filter((p) => !p.closest('[data-testid="contacts-device-section"]'))

    expect(devicePanels().length).toBeGreaterThan(0)
    expect(devicePanels().every((p) => p.hasAttribute('data-closed'))).toBe(true)
    // 个人 + 群组
    expect(otherPanels()).toHaveLength(2)
    expect(otherPanels().every((p) => p.hasAttribute('data-open'))).toBe(true)
    expect(otherPanels()[0]?.querySelector('[data-contact-id="alice"]')).toBeTruthy()
    expect(otherPanels()[1]?.textContent).toContain('Plain Group')

    // 搜索时整棵树让位给结果表(命中不再被折叠藏住);清空后折叠状态原样 —— 用户点开的设备段仍开着
    await clickElement(devicePanels()[0].closest('[data-testid="contacts-device-section"]')!.querySelector('[data-slot="section-label"]') as HTMLElement)
    expect(devicePanels()[0].hasAttribute('data-open')).toBe(true)
    const browse = () => harness.container.querySelector('[data-testid="contacts-browse"]')
    const search = harness.container.querySelector('input[placeholder="搜索联系人"]') as HTMLInputElement
    await typeInto(search, 'shared')
    expect(browse()?.className).toBe('hidden')
    expect(harness.container.querySelector('[data-testid="contacts-search-results"] [data-contact-id="shared-agent"]')).toBeTruthy()
    await typeInto(search, '')
    expect(browse()?.className).toBe('contents')
    expect(devicePanels()[0].hasAttribute('data-open')).toBe(true)
    expect(otherPanels().every((p) => p.hasAttribute('data-open'))).toBe(true)
  })
})
