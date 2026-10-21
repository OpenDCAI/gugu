// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateGroupChatForm } from '../../../../apps/desktop/src/components/CreateGroupChatModal'
import { contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
describe('CreateGroupChatModal member list', () => {
  it('lists people before agents', async () => {
    await renderWithAppProviders(harness, createNode(CreateGroupChatForm, { onClose: () => {}, onCreated: () => {} }), {
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: {
        contacts: [
          contact({ id: 'my-agent', display_name: 'Helper', type: 'agent', owner_user_id: 'owner-1' }),
          contact({ id: 'alice', display_name: 'Alice' })
        ]
      },
      chat: { chats: [] }
    })
    const modal = harness.container as HTMLElement
    const order = Array.from(modal.querySelectorAll('[data-contact-option]')).map((row) => (row as HTMLElement).dataset.contactOption)
    expect(order).toEqual(['alice', 'my-agent'])
  })
})
