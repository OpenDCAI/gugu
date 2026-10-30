// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { ChatSummariesHost } from '../../../../apps/desktop/src/components/chat/ChatSummariesHost'
import { readChatSummaries, resolveChatId } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
const scope = vi.hoisted(() => ({ chats: [{ id: 'dm', public_id: 216189, kind: 'dm', peer_user_id: 'agent', unread_count: 10, unread_locator: { message_id: 'first' } }], contacts: [{ id: 'agent', display_name: 'Agent' }] }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: scope.chats, chatsRead: true, identitiesById: { agent: { display_name: 'Agent' } } }) }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: scope.contacts }) }))
vi.mock('../../../../apps/desktop/src/hooks/useNativeAgentChats', () => ({ useNativeAgentChats: (chats: unknown) => chats }))
const harness = createReactHarness()
afterEach(() => harness.cleanup())
it('publishes destination and first-unread identity in a phone shell with no desktop chat slot', async () => {
  await harness.render(<ChatSummariesHost />)
  expect(resolveChatId('216189')).toBe('dm')
  expect(readChatSummaries()?.get('dm')).toMatchObject({ name: 'Agent', firstUnreadMessageId: 'first', unreadCount: 10 })
  harness.cleanup()
  expect(resolveChatId('216189')).toBeNull()
})
