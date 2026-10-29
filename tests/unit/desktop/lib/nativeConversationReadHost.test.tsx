// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithConversations } from '../../../support/conversationAccountStub'
import { createReactHarness, chat, message, displayIdentity } from '../../../support/testHarness'
import { NativeConversationReadHost } from '../../../../apps/desktop/src/components/chat/NativeConversationReadHost'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishNativeConversationVisibility } from '../../../../apps/desktop/src/lib/nativeConversationVisibility'
import { updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
const scope = vi.hoisted(() => ({ mark: vi.fn(async () => undefined), messages: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {
  getMessages: async () => scope.messages, _callCountsBySource: {}, markRead: scope.mark,
  getOtherMembersReadSeqs: async () => ({}), markMessageRead: async () => undefined,
  revalidateWindow: async (ids: string[]) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }),
} }))
const harness = createReactHarness()
let release: (() => void) | undefined
afterEach(() => { harness.cleanup(); release?.(); publishNativeConversationVisibility('native', null); removeDeviceSessions('host'); scope.mark.mockReset() })
it('writes visible MCP receipts through the real IM account cache without opening an old DM presenter', async () => {
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 3, unread_locator: { message_id: 'one', message_seq: 1, cursor_seq: 0, stream_kind: 'main', stream_id: 'main', thread_root_id: null, unread_count: 3, version: 1, is_marked_unread: false } })
  scope.messages = ['one', 'two', 'three'].map((id, i) => message({ id, chat_id: 'dm', seq: i + 1, sender_user_id: 'agent', is_mine: false }))
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'session', agent: { userId: 'agent' } } as never] })
  await renderWithConversations(harness, <NativeConversationReadHost />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  expect(scope.mark).not.toHaveBeenCalled()
  await act(async () => { publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['tool:one:sent:one', 'tool:two:sent:two'], aliases: new Map(['one', 'two', 'three'].map(id => [`tool:${id}:sent:${id}`, [id]])) }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 2))
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 3)
})
