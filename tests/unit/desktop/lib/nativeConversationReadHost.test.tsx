// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderWithConversations } from '../../../support/conversationAccountStub'
import { createReactHarness, chat, message, displayIdentity } from '../../../support/testHarness'
import { NativeConversationReadHost } from '../../../../apps/desktop/src/components/chat/NativeConversationReadHost'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishNativeConversationVisibility } from '../../../../apps/desktop/src/lib/nativeConversationVisibility'
import { updateDeviceSessions, removeDeviceSessions, publishDirectoryDevices } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { useChatStore } from '../../../../apps/desktop/src/store/chatContext'
const scope = vi.hoisted(() => ({ mark: vi.fn(async (_chatId: string, _seq: number) => undefined), messages: [] as unknown[] }))
// 云端主线读位经唯一写入口 writeRead;这里按 (chatId, seq) 记下它。
vi.mock('../../../../apps/desktop/src/lib/readWriter', async (original) => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(),
  writeRead: async (target: { kind: string; chatId?: string; seq?: number }) => (target.kind === 'main' ? scope.mark(target.chatId!, target.seq!) : undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {
  getMessages: async () => scope.messages, _callCountsBySource: {},
  getOtherMembersReadSeqs: async () => ({}),
  revalidateWindow: async (ids: string[]) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }),
} }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
let release: (() => void) | undefined
afterEach(() => { harness.cleanup(); release?.(); release = undefined; publishNativeConversationVisibility('native', null); removeDeviceSessions('host'); publishDirectoryDevices([]); scope.mark.mockReset() })
it('writes visible MCP receipts through the real IM account cache without opening an old DM presenter', async () => {
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 3, unread_locator: { message_id: 'one', message_seq: 1, cursor_seq: 0, stream_kind: 'main', stream_id: 'main', thread_root_id: null, unread_count: 3, addressed_count: 3, version: 1, is_marked_unread: false } })
  scope.messages = ['one', 'two', 'three'].map((id, i) => message({ id, chat_id: 'dm', seq: i + 1, sender_user_id: 'agent', is_mine: false }))
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'session', agent: { userId: 'agent' } } as never] })
  await renderWithConversations(harness, <NativeConversationReadHost />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  expect(scope.mark).not.toHaveBeenCalled()
  await act(async () => { publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['tool:one:sent:one', 'tool:two:sent:two'], dmIds: new Map(['one', 'two', 'three'].map(id => [`tool:${id}:sent:${id}`, [id]])) }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 2))
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 3)
})
it('starts reading an already visible task when committed ownership becomes available after the viewport', async () => {
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 2 })
  scope.messages = ['one', 'two'].map((id, i) => message({ id, chat_id: 'dm', seq: i + 1, sender_user_id: 'agent', is_mine: false }))
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'session', agent: { userId: 'agent' } } as never] })
  publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['receipt-one'], dmIds: new Map([['receipt-one', ['one']], ['receipt-two', ['two']]]) })
  await renderWithConversations(harness, <NativeConversationReadHost />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  expect(scope.mark).not.toHaveBeenCalled()
  await act(async () => { release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 1))
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 2)
})
it('resolves a current-device task from the account directory even before its live list has arrived', async () => {
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 2 })
  scope.messages = ['one', 'two'].map((id, i) => message({ id, chat_id: 'dm', seq: i + 1, sender_user_id: 'agent', is_mine: false }))
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  publishDirectoryDevices([{ device_id: 'host', is_current_device: true, is_online: true, capabilities: {}, projects: [], session_digest: [{ conversationId: 'session', projectId: 'project', title: 'Task', harness: 'claude', supported: true, agentUserId: 'agent', nativeInputVersion: 1 }] } as never])
  await renderWithConversations(harness, <NativeConversationReadHost />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  await act(async () => { publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['receipt-one'], dmIds: new Map([['receipt-one', ['one']], ['receipt-two', ['two']]]) }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 1))
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 2)
})
it('continues reading after another surface clears the first unread captured by the retained task', async () => {
  const locator = { message_id: 'one', message_seq: 1, cursor_seq: 0, stream_kind: 'main' as const, stream_id: 'main', thread_root_id: null, unread_count: 3, addressed_count: 3, version: 1, is_marked_unread: false }
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 3, unread_locator: locator })
  scope.messages = ['one', 'two', 'three'].map((id, i) => message({ id, chat_id: 'dm', seq: i + 1, sender_user_id: 'agent', is_mine: false }))
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'session', agent: { userId: 'agent' } } as never] })
  const aliases = new Map(['one', 'two', 'three'].map(id => [`receipt-${id}`, [id]]))
  publishNativeConversationVisibility('native', { sessionId: 'session', visible: [], dmIds: aliases })
  let advance!: () => void
  function Fixture() {
    const { upsertChat } = useChatStore('upsertChat')
    advance = () => upsertChat({ ...row, last_read_seq: 1, unread_count: 2, unread_locator: { ...locator, message_id: 'two', message_seq: 2, cursor_seq: 1 } })
    return <NativeConversationReadHost />
  }
  await renderWithConversations(harness, <Fixture />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  expect(scope.mark).not.toHaveBeenCalled()
  await act(async () => { advance(); publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['receipt-two'], dmIds: aliases }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 2))
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 3)
})

it('keeps reading receipts that become projected after the IM row reached an already open task', async () => {
  const locator = { message_id: 'one', message_seq: 1, cursor_seq: 0, stream_kind: 'main' as const, stream_id: 'main', thread_root_id: null, unread_count: 1, addressed_count: 1, version: 1, is_marked_unread: false }
  const row = chat({ id: 'dm', peer_user_id: 'agent', kind: 'ai', last_read_seq: 0, unread_count: 1, unread_locator: locator })
  scope.messages = [message({ id: 'one', chat_id: 'dm', seq: 1, sender_user_id: 'agent', is_mine: false })]
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'session', agent: { userId: 'agent' } } as never] })
  publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['receipt-one'], dmIds: new Map([['receipt-one', ['one']]]) })
  let arrive!: () => void
  function Fixture() {
    const { appendMessage } = useChatStore('appendMessage')
    arrive = () => appendMessage(message({ id: 'two', chat_id: 'dm', seq: 2, sender_user_id: 'agent', is_mine: false }))
    return <NativeConversationReadHost />
  }
  await renderWithConversations(harness, <Fixture />, undefined, { chat: { chats: [row], identitiesById: { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'user-1' }) } } })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 1))
  await act(async () => { arrive() })
  expect(scope.mark).not.toHaveBeenCalledWith('dm', 2)
  await act(async () => { publishNativeConversationVisibility('native', { sessionId: 'session', visible: ['receipt-two'], dmIds: new Map([['receipt-one', ['one']], ['receipt-two', ['two']]]) }) })
  await vi.waitFor(() => expect(scope.mark).toHaveBeenCalledWith('dm', 2))
})
