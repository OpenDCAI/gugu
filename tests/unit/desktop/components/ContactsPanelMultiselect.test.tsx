// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
describe('ContactsPanel contact multi-select', () => {
  it('accumulates and toggles contact selection, preserves it through search, and preselects group creation', async () => {
    await renderWithAppProviders(harness, createNode(ContactsPanel, {}), { shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: {
        contacts: [
          contact({ id: 'alice', display_name: 'Alice' }),
          contact({ id: 'brenda', display_name: 'Brenda' }),
          contact({ id: 'charlie', display_name: 'Charlie' })
        ]
      },
      chat: { chats: [] }
    })
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.contactsSelectModeButton}"]`) as HTMLElement)
    // @@@4322-selection-dock 批量动作在 0 人时就在位、且禁用 —— 旧写法是「选够人才渲染」,
    // 于是勾第一个人的瞬间按钮凭空出现、列表跳版。这条断言钉住「在位」与「禁用」两件事。
    const createGroupButton = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.contactsCreateGroupFromSelection}"]`) as HTMLButtonElement | null
    expect(createGroupButton()).toBeTruthy()
    expect(createGroupButton()?.disabled).toBe(true)
    const rows = () => Array.from(harness.container.querySelectorAll('[data-contact-option]')) as HTMLElement[]
    await clickElement(rows().find((row) => row.dataset.contactOption === 'alice')!)
    await clickElement(rows().find((row) => row.dataset.contactOption === 'brenda')!)
    expect(harness.container.textContent).toContain('已选 2 人')
    expect(createGroupButton()?.disabled).toBe(false)
    expect(rows().find((row) => row.dataset.contactOption === 'alice')?.getAttribute('aria-pressed')).toBe('true')
    await clickElement(rows().find((row) => row.dataset.contactOption === 'alice')!)
    expect(harness.container.textContent).toContain('已选 1 人')
    const search = harness.container.querySelector('input[placeholder="搜索联系人"]') as HTMLInputElement
    await typeInto(search, 'charlie')
    const results = () => harness.container.querySelector('[data-testid="contacts-search-results"]') as HTMLElement
    expect(results().querySelector('[data-contact-option="brenda"]')).toBeNull()
    expect(results().querySelector('[data-contact-option="charlie"]')).toBeTruthy()
    expect(harness.container.textContent).toContain('已选 1 人')
    await typeInto(search, '')
    await clickElement(harness.container.querySelector('[data-contact-option="charlie"]') as HTMLElement)
    await clickElement(createGroupButton() as HTMLElement)
    const modal = document.body.querySelector('[data-testid="create-group-modal"]') as HTMLElement
    expect(modal).toBeTruthy()
    expect(modal.querySelector('[data-contact-option="charlie"]')).toBeTruthy()
  })
})
