// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../apps/desktop/src/components/ChatListPanel'
import { chat, createReactHarness, displayIdentity, renderWithAppProviders } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatuses: () => ({}) }))

const activityAt = new Date().toISOString()
const rows = [
  chat({ id: 'group', kind: 'group', name: 'Shared work', last_message_at: activityAt, last_message_preview: 'A group message' }),
  chat({ id: 'person', kind: 'dm', peer_user_id: 'human', last_message_at: activityAt, last_message_preview: 'A personal message' }),
  chat({ id: 'agent', kind: 'ai', peer_user_id: 'external-agent', last_message_at: activityAt, last_message_preview: 'An agent message' }),
  chat({ id: 'topic', kind: 'topic', name: 'A topic', source_chat_id: 'group', last_message_at: activityAt, last_message_preview: 'A topic message' }),
]
const identitiesById = {
  human: displayIdentity('human', { display_name: 'Human contact' }),
  'external-agent': displayIdentity('external-agent', { type: 'agent', display_name: 'External agent' }),
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function render(scope: 'all' | 'groups') {
  await renderWithAppProviders(harness, <ChatListPanel activeTab="chats" mobile listScope={scope} />, {
    chat: { chats: rows, identitiesById },
    contacts: { contacts: [] },
  })
}

describe('mobile workspace group list', () => {
  it('shows only real groups and does not require external agent DMs', async () => {
    await render('groups')
    const list = harness.container.querySelector('[role="listbox"]')!
    expect(list.textContent).toContain('Shared work')
    expect(list.textContent).not.toContain('Human contact')
    expect(list.textContent).not.toContain('External agent')
    expect(list.textContent).not.toContain('A topic')
    expect(rows.map((row) => row.id)).toEqual(['group', 'person', 'agent', 'topic'])
  })

  it('keeps the existing all-chat projection available without deleting private conversations', async () => {
    await render('groups')
    await render('all')
    const list = harness.container.querySelector('[role="listbox"]')!
    expect(list.textContent).toContain('Shared work')
    expect(list.textContent).toContain('Human contact')
    expect(list.textContent).toContain('External agent')
    expect(list.textContent).toContain('A topic')
  })
})
