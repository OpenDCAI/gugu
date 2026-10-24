// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import {
  chat,
  createNode,
  createReactHarness,
  deferred,
  message as messageItem
} from '../../../support/testHarness'
const {
  authUser,
  setUserMock,
  notificationSettings,
  chatServiceMock,
  getUnreadLocatorMessagesMock,
  getUnreadLocatorWindowMock,
  openImRepositoryMock,
  revisionListeners,
  revisionCoordinatorMock,
} =
  vi.hoisted(() => ({
    authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
    setUserMock: vi.fn(),
    notificationSettings: { messages: false },
    chatServiceMock: {
      _callCountsBySource: {},
      getMessages: vi.fn(),
      getThreadMessages: vi.fn(),
      getOtherMembersReadSeqs: vi.fn(),
      fetchMessageOverlays: vi.fn(),
      revalidateWindow: vi.fn(),
      markRead: vi.fn(),
      toggleReaction: vi.fn(),
      clearMessagesForMe: vi.fn(),
      deleteMessage: vi.fn(),
    },
    getUnreadLocatorMessagesMock: vi.fn(),
    getUnreadLocatorWindowMock: vi.fn(),
    // @@@947 - openLocalSyncDb is overridden per-test to a memory-backed db so the L2 cold-start cache is
    openImRepositoryMock: vi.fn(),
    revisionListeners: new Map<string, (operations: readonly unknown[]) => void | Promise<void>>(),
    revisionCoordinatorMock: {
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(),
      retryPending: vi.fn(),
      whenIdle: vi.fn().mockResolvedValue(undefined),
    },
  }))
let latestStore: import('../../../../apps/desktop/src/store/chatContext').ChatContextValue | null =
  null
type ChatHarness = ReturnType<typeof createReactHarness>
let harness: ChatHarness | null = null
vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({
    user: authUser,
    loading: false,
    setUser: setUserMock
  })
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: chatServiceMock
}))
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocatorMessages', () => ({
  getUnreadLocatorWindow: getUnreadLocatorWindowMock,
  getUnreadLocatorMessages: getUnreadLocatorMessagesMock,
}))
// @@@947 - keep the real L2 adapter (write/readCachedMessageWindow + memory backing) but override the
vi.mock('../../../../apps/desktop/src/lib/imRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/imRepository')>()
  return { ...actual, openImRepository: openImRepositoryMock }
})
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn(() => ({ userId: 'test-user', eventName: 'message_created', listenerId: 1 })),
  unsubscribeAuthenticatedRealtimeChannel: vi.fn(),
  unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/accountRevisionCoordinator', () => ({
  createAccountRevisionCoordinator: () => revisionCoordinatorMock,
  readRevisionResourceKey: (payload: unknown, event: string) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${event} revision payload is malformed`)
    const key = payload as { chat_id?: unknown; entity_id?: unknown }
    if (typeof key.chat_id !== 'string' || !key.chat_id) throw new Error(`${event} revision payload requires chat_id`)
    if (key.entity_id !== undefined && (typeof key.entity_id !== 'string' || !key.entity_id)) throw new Error(`${event} revision payload has malformed entity_id`)
    return { chatId: key.chat_id, entityId: key.entity_id ?? null }
  },
  // #5649 与真实实现同口径:entity_id 必有;last_read_seq 缺省 ⇒ null(迁移前旧行),否则必须是非负安全整数
  readMessageCreatedRevision: (payload: unknown) => {
    const key = payload as { chat_id: string; entity_id?: string; message?: unknown }
    if (!key.entity_id) throw new Error('message_created revision requires entity_id')
    if (key.message === undefined || key.message === null) return { chatId: key.chat_id, messageId: key.entity_id, message: null }
    if (typeof key.message !== 'object' || (key.message as { id?: unknown }).id !== key.entity_id) throw new Error('message_created revision has malformed message')
    return { chatId: key.chat_id, messageId: key.entity_id, message: key.message }
  },
  readDeliveryRevision: (payload: unknown) => {
    const key = payload as { chat_id: string; entity_id?: string; device_id?: unknown; status?: unknown }
    if (!key.entity_id) throw new Error('delivery_changed revision requires entity_id')
    if (key.device_id === undefined && key.status === undefined) return { chatId: key.chat_id, messageId: key.entity_id, receipt: null }
    if (typeof key.device_id !== 'string' || !key.device_id || (key.status !== 'delivered' && key.status !== 'read')) throw new Error('delivery_changed revision has malformed receipt')
    return { chatId: key.chat_id, messageId: key.entity_id, receipt: { deviceId: key.device_id, status: key.status } }
  },
  readMemberReadRevision: (payload: unknown) => {
    const key = payload as { chat_id: string; entity_id?: string; last_read_seq?: unknown }
    if (!key.entity_id) throw new Error('member_read_changed revision requires entity_id')
    const raw = key.last_read_seq
    if (raw === undefined || raw === null) return { chatId: key.chat_id, userId: key.entity_id, lastReadSeq: null }
    const seq = typeof raw === 'string' ? Number(raw) : raw
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new Error('member_read_changed revision has malformed last_read_seq')
    return { chatId: key.chat_id, userId: key.entity_id, lastReadSeq: seq }
  },
  // #6470 与真实实现同口径:行触发器用 user_id 点名成员;sync_since 并上的 tombstone 必须是布尔
  readMemberRosterRevision: (payload: unknown) => {
    const key = payload as { chat_id: string; user_id?: string; entity_id?: string; tombstone?: unknown }
    if (typeof key.tombstone !== 'boolean') throw new Error('chat_members_changed revision requires boolean tombstone')
    return { chatId: key.chat_id, memberId: key.user_id ?? key.entity_id ?? null, left: key.tombstone }
  },
}))
// @@@chat-projection 测试替身 —— 这些判据守的是 **store 的行为**(列表反映真值、取数失败要拒绝、
const projectionStub = {
  rows: [] as unknown[],
  identityRows: [] as unknown[],
  revoked: new Set<string>(),
  advanceImpl: null as null | (() => Promise<unknown[] | null>),
  reset() {
    projectionStub.rows = []
    projectionStub.identityRows = []
    projectionStub.revoked = new Set()
    projectionStub.advanceImpl = null
  },
}
const PROJECTED_EVENTS_STUB = [
  'chat_changed', 'chat_meta_changed', 'chat_members_changed',
  'member_read_changed', 'member_stream_read_changed',
  'message_created', 'message_deleted', 'reaction_changed', 'delivery_changed',
  'agent_changed', 'friendship_changed',
] as const
vi.mock('../../../../apps/desktop/src/lib/chatProjection', () => ({
  createChatProjection: () => ({
    hydrate: async () => {
      const snapshot = await serverChatList()
      projectionStub.identityRows = snapshot.identities
      return snapshot.chats
    },
    advance: async () => {
      if (projectionStub.advanceImpl) return projectionStub.advanceImpl()
      return projectionStub.rows
    },
    ingestLocalWrite: () => projectionStub.rows,
    attach: ({ subscribe, cursor, signal, publish }: {
      subscribe: (events: readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => () => void
      cursor: () => string
      signal: () => AbortSignal
      publish: (rows: unknown[]) => Promise<void>
    }) => subscribe(PROJECTED_EVENTS_STUB, async () => {
      cursor(); signal()
      const rows = projectionStub.advanceImpl ? await projectionStub.advanceImpl() : projectionStub.rows
      if (rows !== null) await publish(rows)
    }),
    current: () => projectionStub.rows,
    identities: () => projectionStub.identityRows,
    isMembershipRevoked: (chatId: string) => projectionStub.revoked.has(chatId),
    ledger: () => [],
    reset: () => undefined,
  }),
  parseWakeHead: () => null,
  readProjectionCursor: () => '0',
}))
vi.mock('../../../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({
  createSupabaseAccountRevisionSource: () => ({}),
}))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({
  useNotificationSettings: () => notificationSettings
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { notifications: false, badge: false },
    showNotification: vi.fn(),
    setBadge: vi.fn()
  }
}))
import { ChatProvider } from '../../../../apps/desktop/src/store/chat'
import { useChatStore } from '../../../../apps/desktop/src/store/chatContext'
import { useReportChatOnScreen } from '../../../../apps/desktop/src/lib/onScreenChat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import {
  readMessageWindow,
  replaceMessageWindow,
  type AccountImRepository,
} from '../../../../apps/desktop/src/lib/imRepository'
// @@@947 - the per-test memory-backed L2 handle (reset in beforeEach). Tests seed it via writeCachedMessages
let memRepository: AccountImRepository
function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return messageItem({
    to_user_ids: ['user-1'],
    content: 'before',
    ...overrides
  })
}
function chatMessage(chatId: string, content: string, overrides: Partial<MessageItem> = {}) {
  return message({
    id: `${chatId}-message`,
    chat_id: chatId,
    seq: 1,
    content,
    ...overrides
  })
}
// @@@chat-projection — 「服务端此刻的会话列表」这个缝从 `chatService.getChats` 换成**投影的 hydrate**
const serverChatList = vi.fn<() => Promise<{ chats: unknown[]; identities: unknown[] }>>()
const chatSnapshot = (chats: ReturnType<typeof chat>[]) => ({ chats, identities: [] })
function mockTwoChats() {
  serverChatList.mockResolvedValue(chatSnapshot([
    chat({ id: 'chat-1', name: 'Chat One' }),
    chat({ id: 'chat-2', name: 'Chat Two' })
  ]))
}
// 替身壳:选中的会话就摆在屏幕上(桌面聊天 tab)。
function Probe() {
  const store = useChatStore()
  latestStore = store
  useReportChatOnScreen(store.activeChatId)
  const { activeChatId, setFollowingTail } = store
  useEffect(() => { setFollowingTail(true) }, [activeChatId, setFollowingTail])
  return createNode(
    'div',
    { 'data-testid': 'messages' },
    ...store.messages.map((msg) => createNode('span', { key: msg.id }, msg.content ?? ''))
  )
}
async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function renderChatProvider(active = true) {
  harness = createReactHarness()
  const ActivatedChatProvider = ChatProvider as unknown as (
    props: { active: boolean; children: unknown }
  ) => ReturnType<typeof ChatProvider>
  await harness.render(createNode(ActivatedChatProvider, { active }, createNode(Probe)))
  await flushReact()
  return harness
}
async function setActiveChat(chatId: string) {
  await act(async () => {
    latestStore?.setActiveChatId(chatId)
  })
  await flushReact()
}
async function actAndFlush(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action()
  })
  await flushReact()
}
async function emitRevision(event: string, payload: Record<string, unknown>): Promise<void> {
  const listener = revisionListeners.get(event)
  if (!listener) throw new Error(`missing revision listener for ${event}`)
  await actAndFlush(() => listener([{ revision: '1', event, payload }]))
}
async function appendMessages(...messages: MessageItem[]): Promise<void> {
  await actAndFlush(() => {
    for (const item of messages) latestStore?.appendMessage(item)
  })
}
async function renderActiveChat(chatId = 'chat-1') {
  const harness = await renderChatProvider()
  await setActiveChat(chatId)
  return harness
}
function expectTextContains(rendered: ChatHarness, ...contents: string[]) {
  for (const content of contents) expect(rendered.container.textContent).toContain(content)
}
function expectTextMissing(rendered: ChatHarness, ...contents: string[]) {
  for (const content of contents) expect(rendered.container.textContent).not.toContain(content)
}
async function resolveDeferred<T>(item: ReturnType<typeof deferred<T>>, value: T): Promise<void> {
  await actAndFlush(() => {
    item.resolve(value)
  })
}
beforeEach(async () => {
  latestStore = null
  revisionListeners.clear()
  revisionCoordinatorMock.start.mockClear()
  revisionCoordinatorMock.stop.mockClear()
  revisionCoordinatorMock.subscribe.mockReset()
  revisionCoordinatorMock.subscribe.mockImplementation(
    (events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      const claimed = typeof events === 'string' ? [events] : [...events]
      for (const event of claimed) revisionListeners.set(event, listener)
      return () => { for (const event of claimed) revisionListeners.delete(event) }
    },
  )
  harness = null
  serverChatList.mockReset()
  chatServiceMock.getMessages.mockReset()
  chatServiceMock.getThreadMessages.mockReset()
  chatServiceMock.getOtherMembersReadSeqs.mockReset()
  chatServiceMock.fetchMessageOverlays.mockReset()
  chatServiceMock.revalidateWindow.mockReset()
  chatServiceMock.markRead.mockReset()
  chatServiceMock.toggleReaction.mockReset()
  chatServiceMock.clearMessagesForMe.mockReset()
  chatServiceMock.deleteMessage.mockReset()
  serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat' })]))
  chatServiceMock.getOtherMembersReadSeqs.mockResolvedValue({})
  chatServiceMock.getThreadMessages.mockResolvedValue([])
  chatServiceMock.fetchMessageOverlays.mockResolvedValue(new Map())
  // @@@947 - default revalidateWindow is a no-op: all queried ids still present, no overlay/body changes.
  chatServiceMock.revalidateWindow.mockImplementation(async (ids: string[]) => ({
    overlays: new Map(),
    mutations: new Map(),
    presentIds: new Set(ids),
  }))
  const actualRepository = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>(
    '../../../../apps/desktop/src/lib/imRepository',
  )
  memRepository = await actualRepository.openImRepository('user-1', {
    adapter: createMemoryLocalSyncDb(),
    storage: window.localStorage,
  })
  openImRepositoryMock.mockReset()
  openImRepositoryMock.mockImplementation(async () => memRepository)
  chatServiceMock.markRead.mockResolvedValue(undefined)
  chatServiceMock.toggleReaction.mockResolvedValue(undefined)
  chatServiceMock.clearMessagesForMe.mockResolvedValue(undefined)
  chatServiceMock.deleteMessage.mockResolvedValue({ chatId: 'chat-1', globallyDeleted: false })
})
afterEach(() => {
  harness?.cleanup()
})
describe('ChatProvider repository ownership', () => {
  it('keeps repository, outbox and realtime owners inert until shell activation', async () => {
    await renderChatProvider(false)
    expect(openImRepositoryMock).not.toHaveBeenCalled()
    expect(serverChatList).not.toHaveBeenCalled()
    expect(revisionCoordinatorMock.start).not.toHaveBeenCalled()
  })
  it('opens once and injects the provider-owned repository through ChatContext', async () => {
    const rendered = await renderChatProvider()
    const first = await latestStore?.getImRepository()
    const second = await latestStore?.getImRepository()
    const staleCapability = latestStore?.getImRepository
    expect(openImRepositoryMock).toHaveBeenCalledTimes(1)
    expect(first).toBe(memRepository)
    expect(second).toBe(memRepository)
    rendered.cleanup()
    harness = null
    await expect(staleCapability?.()).rejects.toThrow('scope user-1 disposed')
    expect(openImRepositoryMock).toHaveBeenCalledTimes(1)
  })
  it('re-arms the mounted account scope after a StrictMode effect replay', async () => {
    const actualRepository = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>(
      '../../../../apps/desktop/src/lib/imRepository',
    )
    openImRepositoryMock.mockImplementation(() => actualRepository.openImRepository('user-1', {
      adapter: createMemoryLocalSyncDb(),
      storage: window.localStorage,
    }))
    harness = createReactHarness()
    await harness.render(createNode(StrictMode, null, createNode(ChatProvider, null, createNode(Probe))))
    await flushReact()
    const currentCapability = latestStore?.getImRepository
    await expect(currentCapability?.()).resolves.toMatchObject({ accountId: 'user-1' })
    harness.cleanup()
    harness = null
    await expect(currentCapability?.()).rejects.toThrow('scope user-1 disposed')
  })
})
// @@@1575 root↔thread 来回切后主线消息区空白(owner P0)：先在 store 层坐实「主线 messages 是否被切话题清空/污染」。
describe('#1575 root↔thread toggle keeps mainline messages', () => {
  it('keeps an open thread when the same chat is selected again', async () => {
    const root = chatMessage('chat-1', 'root-msg', { id: 'root-1', seq: 1 })
    const reply = chatMessage('chat-1', 'thread-reply', { id: 'reply-1', seq: 2, thread_root_id: 'root-1' })
    chatServiceMock.getMessages.mockResolvedValue([root])
    ;(chatServiceMock as Record<string, unknown>).markThreadRoot = vi.fn().mockResolvedValue(undefined)
    chatServiceMock.getThreadMessages.mockResolvedValue([root, reply])
    await renderActiveChat('chat-1')
    await actAndFlush(() => latestStore?.openThread('root-1'))
    await vi.waitFor(() => {
      expect(latestStore?.activeThreadRootId).toBe('root-1')
      expect(latestStore?.threadMessages.map((message) => message.id)).toEqual(['root-1', 'reply-1'])
    })
    await setActiveChat('chat-1')
    expect(latestStore?.activeChatId).toBe('chat-1')
    expect(latestStore?.activeThreadRootId).toBe('root-1')
    expect(latestStore?.threadMessages.map((message) => message.id)).toEqual(['root-1', 'reply-1'])
  })
  it('keeps the main timeline messages after openThread(root) → openThread(null)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One' })]))
    const mainline = [
      chatMessage('chat-1', 'root-msg-1', { id: 'm1', seq: 1 }),
      chatMessage('chat-1', 'root-msg-2', { id: 'm2', seq: 2 }),
    ]
    chatServiceMock.getMessages.mockResolvedValue(mainline)
    ;(chatServiceMock as Record<string, unknown>).markThreadRoot = vi.fn().mockResolvedValue(undefined)
    ;(chatServiceMock as Record<string, unknown>).getThreadMessages = vi.fn().mockResolvedValue([
      chatMessage('chat-1', 'thread-reply', { id: 't1', seq: 3, thread_root_id: 'm1' }),
    ])
    const rendered = await renderActiveChat('chat-1')
    expectTextContains(rendered, 'root-msg-1', 'root-msg-2')
    await actAndFlush(() => latestStore?.openThread('m1'))
    await actAndFlush(() => latestStore?.openThread(null))
    expect(latestStore?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expectTextContains(rendered, 'root-msg-1', 'root-msg-2')
  })
})
describe('ChatProvider realtime freshness', () => {
  it('reflects server truth after a durable chat operation — without a second whole-list refetch', async () => {
    serverChatList
      .mockResolvedValueOnce(chatSnapshot([chat({ id: 'chat-1', name: 'Before reconnect' })]))
    await renderChatProvider()
    expect(serverChatList).toHaveBeenCalledTimes(1)
    expect(revisionListeners.get('chat_changed')).toBeTypeOf('function')
    projectionStub.advanceImpl = async () => [
      chat({ id: 'chat-1', name: 'Before reconnect' }),
      chat({ id: 'chat-2', name: 'Recovered chat' }),
    ]
    await actAndFlush(() => revisionListeners.get('chat_changed')?.([
      { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-2' } },
    ]))
    expect(latestStore?.chats.map((item) => item.id)).toEqual(['chat-1', 'chat-2'])
    expect(serverChatList, '一条通知不得再整表重拉一遍').toHaveBeenCalledTimes(1)
  })
  it('rejects a durable chat operation when the authoritative keyed read fails', async () => {
    serverChatList.mockResolvedValueOnce(chatSnapshot([]))
    await renderChatProvider()
    projectionStub.advanceImpl = async () => { throw new Error('chat projection read unavailable') }
    const listener = revisionListeners.get('chat_changed')
    if (!listener) throw new Error('missing chat revision listener')
    await expect(listener([
      { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
    ])).rejects.toThrow('chat projection read unavailable')
  })
  it('refreshes the active chat snapshot when a durable message revision arrives', async () => {
    const before = message({ id: 'before', seq: 1, content: 'before' })
    const gap = message({ id: 'gap', seq: 2, content: 'gap' })
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([before]).mockResolvedValueOnce([gap])
    const harness = await renderActiveChat()
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(1)
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'gap' })
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(2)
    expect(chatServiceMock.getMessages).toHaveBeenLastCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 1)
    expectTextContains(harness, 'before', 'gap')
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith('chat-1', 2)
  })
  it('keeps the revision refresh snapshot when the older initial load resolves later', async () => {
    const before = message({ id: 'before', seq: 1, content: 'before' })
    const gap = message({ id: 'gap', seq: 2, content: 'gap' })
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat', next_message_seq: 3 })]))
    const initialLoad = deferred<MessageItem[]>()
    chatServiceMock.getMessages
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce([before, gap])
    const harness = await renderActiveChat()
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'gap' })
    expectTextContains(harness, 'gap')
    await resolveDeferred(initialLoad, [before])
    expectTextContains(harness, 'before', 'gap')
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith('chat-1', 2)
  })
  it('marks read using the latest persisted seq when optimistic messages are cached', async () => {
    const before = message({ id: 'before', seq: 1, content: 'before' })
    const gap = message({ id: 'gap', seq: 2, content: 'gap' })
    const optimistic = message({
      id: 'optimistic',
      seq: -1,
      content: 'sending',
      is_mine: true,
      local_send_state: 'sending',
      delivered: false
    })
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([before]).mockResolvedValueOnce([gap])
    const harness = await renderActiveChat()
    await appendMessages(optimistic)
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'gap' })
    expectTextContains(harness, 'gap', 'sending')
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith('chat-1', 2)
    expect(chatServiceMock.markRead).not.toHaveBeenCalledWith('chat-1', -1)
  })
  it('does not treat an empty refresh snapshot as authoritative deletion', async () => {
    const local = message({ id: 'local-message', seq: 1, content: 'local visible' })
    chatServiceMock.getMessages.mockResolvedValue([])
    const harness = await renderActiveChat()
    await appendMessages(local)
    expectTextContains(harness, 'local visible')
    await actAndFlush(() => latestStore?.refreshMessages('chat-1'))
    expectTextContains(harness, 'local visible')
  })
  it('does not let an older in-flight snapshot revive messages after clearMessages', async () => {
    const old = message({ id: 'old-message', seq: 1, content: 'old visible' })
    const oldSnapshot = deferred<MessageItem[]>()
    chatServiceMock.getMessages.mockReturnValueOnce(oldSnapshot.promise)
    const harness = await renderActiveChat()
    await appendMessages(old)
    expectTextContains(harness, 'old visible')
    await actAndFlush(() => latestStore?.clearMessages())
    expectTextMissing(harness, 'old visible')
    await resolveDeferred(oldSnapshot, [old])
    expectTextMissing(harness, 'old visible')
  })
  it('keeps a pending reaction action bound to its original chat after switching chats', async () => {
    const chatOneMessage = chatMessage('chat-1', 'chat one visible')
    const chatTwoMessage = chatMessage('chat-2', 'chat two visible')
    const toggleRequest = deferred<void>()
    const reactionSnapshot = deferred<MessageItem[]>()
    mockTwoChats()
    chatServiceMock.toggleReaction.mockReturnValueOnce(toggleRequest.promise)
    chatServiceMock.getMessages.mockImplementation(
      async (chatId: string, _userId: string, source: string) => {
        if (source === 'toggleReaction') return reactionSnapshot.promise
        if (chatId === 'chat-1') return [chatOneMessage]
        if (chatId === 'chat-2') return [chatTwoMessage]
        return []
      }
    )
    const harness = await renderActiveChat()
    expectTextContains(harness, 'chat one visible')
    void latestStore?.toggleReaction('chat-1-message', '👍')
    await flushReact()
    await setActiveChat('chat-2')
    expectTextContains(harness, 'chat two visible')
    await actAndFlush(() => {
      toggleRequest.resolve(undefined)
    })
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'toggleReaction')
    await resolveDeferred(reactionSnapshot, [chatOneMessage])
    expectTextContains(harness, 'chat two visible')
    expectTextMissing(harness, 'chat one visible')
  })
  it('logs active message load failures instead of silently hiding them', async () => {
    const error = new Error('load failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    chatServiceMock.getMessages.mockRejectedValueOnce(error)
    try {
      await renderActiveChat()
      expect(consoleError).toHaveBeenCalledWith('[ChatStore] load messages error', error)
    } finally {
      consoleError.mockRestore()
    }
  })
  it('logs markRead failures from applied message snapshots', async () => {
    const error = new Error('mark read failed')
    const visible = message({ id: 'visible', seq: 1, content: 'visible text' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    chatServiceMock.getMessages.mockResolvedValueOnce([visible])
    chatServiceMock.markRead.mockRejectedValueOnce(error)
    try {
      const harness = await renderActiveChat()
      expectTextContains(harness, 'visible text')
      expect(consoleError).toHaveBeenCalledWith('[ChatStore] markRead failed', error)
    } finally {
      consoleError.mockRestore()
    }
  })
  it('pages in older history via loadOlderMessages and tracks hasMoreOlder', async () => {
    const manyMessages = (startSeq: number, count: number): MessageItem[] =>
      Array.from({ length: count }, (_, i) =>
        message({ id: `m${startSeq + i}`, seq: startSeq + i, content: `msg-${startSeq + i}` }),
      )
    // @@@946 回港 #4644/#5b — cold-open initial 取 INITIAL_PAGE(30),非旧的 60。
    const initial = manyMessages(131, 30) // seq 131..160 (a full initial page → older likely exists)
    const older = manyMessages(71, 60) // seq 71..130
    chatServiceMock.getMessages.mockResolvedValueOnce(initial).mockResolvedValueOnce(older)
    await renderActiveChat()
    expect(latestStore?.hasMoreOlder).toBe(true)
    expect(latestStore?.messages).toHaveLength(30)
    latestStore?.setFollowingTail(false)
    await actAndFlush(() => latestStore?.loadOlderMessages())
    expect(chatServiceMock.getMessages).toHaveBeenLastCalledWith('chat-1', 'user-1', 'loadOlder', 60, 131)
    expect(latestStore?.messages).toHaveLength(90)
    expect(latestStore?.messages[0]?.seq).toBe(71)
    expect(latestStore?.hasMoreOlder).toBe(true)
  })
  it('does not flag older history when the initial page is short', async () => {
    chatServiceMock.getMessages.mockResolvedValueOnce([
      message({ id: 'a', seq: 0, content: 'a' }),
      message({ id: 'b', seq: 1, content: 'b' }),
    ])
    await renderActiveChat()
    expect(latestStore?.hasMoreOlder).toBe(false)
    await actAndFlush(() => latestStore?.loadOlderMessages())
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(1)
  })
})
describe('#1873 reaction_changed realtime', () => {
  const reactedMessage = (reactions: MessageItem['reactions'] = []) =>
    chatMessage('chat-1', 'react target', { id: 'chat-1-message', seq: 1, reactions })
  it('applies an incoming reaction to the open chat live (no reopen)', async () => {
    chatServiceMock.getMessages.mockResolvedValue([reactedMessage()])
    chatServiceMock.fetchMessageOverlays.mockResolvedValue(
      new Map([[
        'chat-1-message',
        { reactions: [{ emoji: '👍', count: 1, my_reaction: false }], delivered: false, delivery_status: null, readers: [] },
      ]]),
    )
    await renderActiveChat('chat-1')
    expect(latestStore?.messages.find((m) => m.id === 'chat-1-message')?.reactions).toEqual([])
    await emitRevision('reaction_changed', { chat_id: 'chat-1', entity_id: 'chat-1-message' })
    expect(chatServiceMock.fetchMessageOverlays).toHaveBeenCalledWith(['chat-1-message'], 'user-1')
    expect(latestStore?.messages.find((m) => m.id === 'chat-1-message')?.reactions).toEqual([
      { emoji: '👍', count: 1, my_reaction: false },
    ])
  })
  it('clears the reaction live when the peer retracts it (overlay now empty)', async () => {
    chatServiceMock.getMessages.mockResolvedValue([
      reactedMessage([{ emoji: '👍', count: 1, my_reaction: false }]),
    ])
    chatServiceMock.fetchMessageOverlays.mockResolvedValue(
      new Map([[
        'chat-1-message',
        { reactions: [], delivered: false, delivery_status: null, readers: [] },
      ]]),
    )
    await renderActiveChat('chat-1')
    expect(latestStore?.messages.find((m) => m.id === 'chat-1-message')?.reactions).toEqual([
      { emoji: '👍', count: 1, my_reaction: false },
    ])
    await emitRevision('reaction_changed', { chat_id: 'chat-1', entity_id: 'chat-1-message' })
    expect(latestStore?.messages.find((m) => m.id === 'chat-1-message')?.reactions).toEqual([])
  })
  it('converges a current-user reaction revision through the authoritative overlay', async () => {
    chatServiceMock.getMessages.mockResolvedValue([reactedMessage()])
    chatServiceMock.fetchMessageOverlays.mockResolvedValue(
      new Map([[
        'chat-1-message',
        { reactions: [{ emoji: '👍', count: 1, my_reaction: true }], delivered: false, delivery_status: null, readers: [] },
      ]]),
    )
    await renderActiveChat('chat-1')
    await emitRevision('reaction_changed', { chat_id: 'chat-1', entity_id: 'chat-1-message' })
    expect(chatServiceMock.fetchMessageOverlays).toHaveBeenCalledWith(['chat-1-message'], 'user-1')
    expect(latestStore?.messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, my_reaction: true },
    ])
  })
  it('only touches delivery/reactions overlay for the reacted id, leaving others untouched', async () => {
    chatServiceMock.getMessages.mockResolvedValue([
      chatMessage('chat-1', 'target', { id: 'm-target', seq: 1 }),
      chatMessage('chat-1', 'other', { id: 'm-other', seq: 2, delivered: true, delivery_status: 'read' }),
    ])
    chatServiceMock.fetchMessageOverlays.mockResolvedValue(
      new Map([[
        'm-target',
        { reactions: [{ emoji: '❤️', count: 2, my_reaction: true }], delivered: false, delivery_status: null, readers: [] },
      ]]),
    )
    await renderActiveChat('chat-1')
    await emitRevision('reaction_changed', { chat_id: 'chat-1', entity_id: 'm-target' })
    const other = latestStore?.messages.find((m) => m.id === 'm-other')
    expect(latestStore?.messages.find((m) => m.id === 'm-target')?.reactions).toEqual([
      { emoji: '❤️', count: 2, my_reaction: true },
    ])
    expect(other?.reactions).toEqual([])
    expect(other?.delivered).toBe(true)
    expect(other?.delivery_status).toBe('read')
  })
  it('rejects when the reaction overlay refetch fails so the durable operation remains pending', async () => {
    const error = new Error('overlay refetch failed')
    chatServiceMock.getMessages.mockResolvedValue([reactedMessage()])
    chatServiceMock.fetchMessageOverlays.mockRejectedValueOnce(error)
    await renderActiveChat('chat-1')
    await expect(emitRevision(
      'reaction_changed',
      { chat_id: 'chat-1', entity_id: 'chat-1-message' },
    )).rejects.toThrow('overlay refetch failed')
  })
})
describe('#1729 message_deleted realtime', () => {
  it('removes a message from the open window when a message_deleted event arrives', async () => {
    chatServiceMock.getMessages.mockResolvedValue([
      chatMessage('chat-1', 'keep', { id: 'm-keep', seq: 1 }),
      chatMessage('chat-1', 'gone', { id: 'm-gone', seq: 2 }),
    ])
    const harness = await renderActiveChat('chat-1')
    expectTextContains(harness, 'keep', 'gone')
    await emitRevision('message_deleted', { chat_id: 'chat-1', entity_id: 'm-gone', tombstone: true })
    expectTextContains(harness, 'keep')
    expectTextMissing(harness, 'gone')
    expect(latestStore?.messages.map((m) => m.id)).toEqual(['m-keep'])
  })
})
// @@@947 - persistent L2 message-window cache: cold-start paint + freshness-gated body fetch (no silent
describe('#947 persistent message-window cache (cold start + freshness gating)', () => {
  const window = (chatId: string, seqs: number[], label = 'l2') =>
    seqs.map((seq) => chatMessage(chatId, `${label}-${seq}`, { id: `m${seq}`, seq }))
  async function macroFlush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  async function waitForStore(predicate: () => boolean, tries = 40) {
    let stable = 0
    for (let i = 0; i < tries; i += 1) {
      stable = predicate() ? stable + 1 : 0
      if (stable >= 3) return
      await macroFlush()
    }
    throw new Error(`waitForStore: condition not met; messages=${JSON.stringify(latestStore?.messages.map((m) => m.id))}`)
  }
  const ids = () => latestStore?.messages.map((m) => m.id) ?? []
  const seqs = () => latestStore?.messages.map((m) => m.seq) ?? []
  async function waitForL2(chatId: string, expectedIds: string[], tries = 40) {
    for (let i = 0; i < tries; i += 1) {
      const w = readMessageWindow(memRepository, chatId)
      if (JSON.stringify(w?.messages.map((m) => m.id) ?? []) === JSON.stringify(expectedIds)) return w
      await macroFlush()
    }
    const w = readMessageWindow(memRepository, chatId)
    throw new Error(`waitForL2: not settled; L2=${JSON.stringify(w?.messages.map((m) => m.id))}`)
  }
  it('paints the L2 window gap-free and SKIPS initialLoad (acceptance ① + ⑥ gap-free)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 6 })]))
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3, 4, 5]), false)
    await setActiveChat('chat-1')
    await waitForStore(() => ids().length === 5)
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(chatServiceMock.getMessages).not.toHaveBeenCalled()
    expect(chatServiceMock.getOtherMembersReadSeqs).toHaveBeenCalledWith('chat-1', 'user-1')
    expect(chatServiceMock.revalidateWindow).toHaveBeenCalled()
  })
  it('merges L2 history when L1 contains only restored optimistic rows (#2270)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([
      chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 4 }),
    ]))
    const heldDelta = deferred<MessageItem[]>()
    chatServiceMock.getMessages.mockReturnValue(heldDelta.promise)
    const rendered = await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2], 'settled'), false)
    await appendMessages(chatMessage('chat-1', 'restored optimistic', {
      id: 'rapid-1',
      seq: -1,
      local_send_state: 'sending',
    }))
    await setActiveChat('chat-1')
    await waitForStore(() => ids().length === 3)
    expect(ids()).toEqual(['m1', 'm2', 'rapid-1'])
    expectTextContains(rendered, 'settled-1', 'settled-2', 'restored optimistic')
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith(
      'chat-1', 'user-1', 'loadNewer', 200, undefined, 2,
    )
    await resolveDeferred(heldDelta, [])
  })
  it('paints L2 then fetches ONLY the loadNewer delta on a small gap (no full reload)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 8 })]))
    chatServiceMock.getMessages.mockResolvedValue(window('chat-1', [6, 7], 'delta'))
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3, 4, 5]), false)
    await setActiveChat('chat-1')
    await waitForStore(() => seqs().length === 7)
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(1)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 5)
    expect(chatServiceMock.getMessages).not.toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', expect.anything())
    expect(seqs()).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
  it('#2160 stale next_message_seq (seq-gap-free) BUT positive unread → still fetches the loadNewer delta & reconciles the missed message', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 6, unread_count: 1 })]))
    chatServiceMock.getMessages.mockResolvedValue(window('chat-1', [6], 'delta'))
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3, 4, 5]), false)
    await setActiveChat('chat-1')
    await waitForStore(() => seqs().length === 6)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 5)
    expect(chatServiceMock.getMessages).not.toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', expect.anything())
    expect(seqs()).toEqual([1, 2, 3, 4, 5, 6])
    expect(ids()).toContain('m6')
  })
  it('#2160 positive unread but loadNewer returns EMPTY (false-positive / thread-only unread) → cache preserved, no wipe, no full reload', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 6, unread_count: 1 })]))
    chatServiceMock.getMessages.mockResolvedValue([]) // authoritative mainline tail: nothing newer than cursor
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3, 4, 5]), false)
    await setActiveChat('chat-1')
    await waitForStore(() => seqs().length === 5)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 5)
    expect(chatServiceMock.getMessages).not.toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', expect.anything())
    expect(seqs()).toEqual([1, 2, 3, 4, 5])
  })
  it('DEGRADES to initialLoad when a >one-page MAINLINE gap comes back as a FULL loadNewer page — contiguous tail, no hole (crux ⑥)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 301 })]))
    const fullPage = Array.from({ length: 200 }, (_, i) => chatMessage('chat-1', `d-${4 + i}`, { id: `d${4 + i}`, seq: 4 + i }))
    const tail = Array.from({ length: 30 }, (_, i) => chatMessage('chat-1', `tail-${271 + i}`, { id: `t${271 + i}`, seq: 271 + i }))
    chatServiceMock.getMessages.mockImplementation(async (_c: string, _u: string, source: string) =>
      source === 'loadNewer' ? fullPage : tail)
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3], 'stale'), true)
    await setActiveChat('chat-1')
    await waitForStore(() => seqs()[0] === 271 && seqs().length === 30)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', 30)
    expect(seqs()).toEqual(Array.from({ length: 30 }, (_, i) => 271 + i))
    expect(latestStore?.messages.some((m) => m.id.startsWith('m'))).toBe(false)
    expect(latestStore?.hasMoreOlder).toBe(true)
  })
  it('falls back to initialLoad when there is no cache at all (acceptance ②)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValue([
      chatMessage('chat-1', 'a', { id: 'a', seq: 1 }),
      chatMessage('chat-1', 'b', { id: 'b', seq: 2 }),
    ])
    await renderActiveChat('chat-1') // memDb empty → no L2 window
    await waitForStore(() => ids().length === 2)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', 30)
    expect(ids()).toEqual(['a', 'b'])
  })
  it('cold reopen revalidation drops a deleted cached message and patches an edited one (acceptance ⑧)', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 4 })]))
    const h = await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', [
      chatMessage('chat-1', 'keep', { id: 'm1', seq: 1 }),
      chatMessage('chat-1', 'old body', { id: 'm2', seq: 2 }),
      chatMessage('chat-1', 'deleted text', { id: 'm3', seq: 3 }),
    ], false)
    chatServiceMock.revalidateWindow.mockImplementation(async () => ({
      overlays: new Map(),
      mutations: new Map([['m2', { content: 'new body', content_type: 'text', retracted_at: null }]]),
      presentIds: new Set(['m1', 'm2']),
    }))
    await setActiveChat('chat-1')
    const persisted = await waitForL2('chat-1', ['m1', 'm2'])
    expect(persisted?.messages.find((m) => m.id === 'm2')?.content).toBe('new body')
    expectTextMissing(h, 'deleted text')
    expect(ids()).toEqual(['m1', 'm2'])
  })
  it('in-memory reopen ALSO degrades on a >NEWER_PAGE gap — pre-existing fix, symmetric with L2 (acceptance ⑦)', async () => {
    serverChatList
      .mockResolvedValueOnce(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 6 })]))
    projectionStub.advanceImpl = async () => [
      chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 400 }),
      chat({ id: 'chat-2', name: 'Chat Two', next_message_seq: 2 }),
    ]
    const firstWindow = window('chat-1', [1, 2, 3, 4, 5], 'old')
    const fullPage = Array.from({ length: 200 }, (_, i) => chatMessage('chat-1', `d-${6 + i}`, { id: `d${6 + i}`, seq: 6 + i }))
    const tail = Array.from({ length: 30 }, (_, i) => chatMessage('chat-1', `new-${370 + i}`, { id: `n${370 + i}`, seq: 370 + i }))
    let chat1Opens = 0
    chatServiceMock.getMessages.mockImplementation(async (chatId: string, _u: string, source: string) => {
      if (chatId === 'chat-2') return []
      if (source === 'loadNewer') return fullPage // @@@1926 real >one-page mainline gap → FULL page → degrade
      chat1Opens += 1
      return chat1Opens === 1 ? firstWindow : tail
    })
    await renderActiveChat('chat-1') // cold initialLoad → seq 1..5 into L1
    await waitForStore(() => seqs().length === 5)
    expect(seqs()).toEqual([1, 2, 3, 4, 5])
    await actAndFlush(() => revisionListeners.get('chat_changed')?.([
      { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
    ]))
    await setActiveChat('chat-2')
    await setActiveChat('chat-1')
    await waitForStore(() => seqs()[0] === 370 && seqs().length === 30)
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', 30)
    expect(seqs()).toEqual(Array.from({ length: 30 }, (_, i) => 370 + i))
    expect(latestStore?.messages.some((m) => m.id.startsWith('m') || m.id.startsWith('o'))).toBe(false)
  })
  it('#1926 does NOT degrade when a thread-inflated gap comes back as a SHORT loadNewer page — keeps cache', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 251 })]))
    chatServiceMock.getMessages.mockResolvedValue([]) // loadNewer: no new mainline; initialLoad must NOT run
    await renderChatProvider()
    await replaceMessageWindow(memRepository, 'chat-1', window('chat-1', [1, 2, 3], 'main'), true)
    await setActiveChat('chat-1')
    await waitForStore(() => seqs().length === 3 && seqs()[0] === 1)
    expect(seqs()).toEqual([1, 2, 3])
    expect(chatServiceMock.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 3)
    expect(chatServiceMock.getMessages).not.toHaveBeenCalledWith('chat-1', 'user-1', 'initialLoad', 30)
  })

  it('#5649 member_read_changed with last_read_seq advances the watermark without a chat_members round trip', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValue([
      chatMessage('chat-1', 'a', { id: 'a', seq: 1 }),
      chatMessage('chat-1', 'b', { id: 'b', seq: 2 }),
    ])
    await renderActiveChat('chat-1')
    await waitForStore(() => ids().length === 2)
    chatServiceMock.getOtherMembersReadSeqs.mockClear()

    await emitRevision('member_read_changed', { chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: 4, tombstone: false })
    expect(latestStore?.memberReadSeqs['user-2']).toBe(4)
    expect(chatServiceMock.getOtherMembersReadSeqs).not.toHaveBeenCalled()

    // 水位单调:更旧的值不会把已读拉回未读
    await emitRevision('member_read_changed', { chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: 2, tombstone: false })
    expect(latestStore?.memberReadSeqs['user-2']).toBe(4)

    // 迁移前落库的旧行没有 last_read_seq ⇒ 仍按旧路回读一次
    chatServiceMock.getOtherMembersReadSeqs.mockResolvedValueOnce({ 'user-2': 5 })
    await emitRevision('member_read_changed', { chat_id: 'chat-1', entity_id: 'user-2', tombstone: false })
    expect(chatServiceMock.getOtherMembersReadSeqs).toHaveBeenCalledWith('chat-1', 'user-1')
    await waitForStore(() => latestStore?.memberReadSeqs['user-2'] === 5)
  })

  it('#5649 delivery_changed with a receipt patches the message row without re-pulling the overlays', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Chat One', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValue([
      chatMessage('chat-1', 'a', { id: 'a', seq: 1 }),
      chatMessage('chat-1', 'b', { id: 'b', seq: 2 }),
    ])
    await renderActiveChat('chat-1')
    await waitForStore(() => ids().length === 2)
    chatServiceMock.revalidateWindow.mockClear()

    await emitRevision('delivery_changed', { chat_id: 'chat-1', entity_id: 'b', device_id: 'gugu-agent:agent-9', status: 'read', tombstone: false })
    const b = () => latestStore?.messages.find((m) => m.id === 'b')
    expect(b()?.delivered).toBe(true)
    expect(b()?.readers).toContain('agent-9')
    expect(chatServiceMock.revalidateWindow).not.toHaveBeenCalled()

    // 迁移前落库的旧行没带 receipt ⇒ 仍按旧路重验证一次
    await emitRevision('delivery_changed', { chat_id: 'chat-1', entity_id: 'b', tombstone: false })
    expect(chatServiceMock.revalidateWindow).toHaveBeenCalled()
  })

  it('#5649 message_created that carries its row lands in the window without a gap-heal read', async () => {
    const before = message({ id: 'before', seq: 1, content: 'before' })
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat', next_message_seq: 3 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([before])
    const harness = await renderActiveChat()
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(1)

    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'arrived', tombstone: false, message: {
      id: 'arrived', chat_id: 'chat-1', sender_user_id: 'user-2', seq: 2, content: 'arrived', content_type: 'text', created_at: '2026-09-15T00:00:01Z',
    } })
    expectTextContains(harness, 'before', 'arrived')
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(1)
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith('chat-1', 2)
  })

  it('#5649 a carried row beyond the verified tail, or a thread reply, still takes the gap-heal path', async () => {
    const before = message({ id: 'before', seq: 1, content: 'before' })
    const two = message({ id: 'two', seq: 2, content: 'two' })
    const three = message({ id: 'three', seq: 3, content: 'three' })
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Fresh chat', next_message_seq: 4 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([before]).mockResolvedValueOnce([two, three]).mockResolvedValueOnce([])
    const harness = await renderActiveChat()

    // seq 3 到了、seq 2 还没:窗口已验证尾是 1,不能把 3 单独落下去(#4439 交错入站)
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'three', tombstone: false, message: {
      id: 'three', chat_id: 'chat-1', sender_user_id: 'user-2', seq: 3, content: 'three', content_type: 'text', created_at: '2026-09-15T00:00:03Z',
    } })
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(2)
    expect(chatServiceMock.getMessages).toHaveBeenLastCalledWith('chat-1', 'user-1', 'loadNewer', 200, undefined, 1)
    expectTextContains(harness, 'before', 'two', 'three')

    // 话题回复不进主线,连话题快照/摘要一起补 ⇒ 仍走补洞
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'reply', tombstone: false, message: {
      id: 'reply', chat_id: 'chat-1', sender_user_id: 'user-2', seq: 4, content: 'reply', content_type: 'text', created_at: '2026-09-15T00:00:04Z', thread_root_id: 'three',
    } })
    expect(chatServiceMock.getMessages).toHaveBeenCalledTimes(3)
  })

  it('#5649 one member\'s read event never drops the other members from the receipt denominator', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Group', next_message_seq: 6 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([message({ id: 'before', seq: 1, content: 'before' })])
    chatServiceMock.getOtherMembersReadSeqs.mockResolvedValue({ 'user-2': 1, 'user-3': 1 })
    await renderActiveChat('chat-1')
    await waitForStore(() => latestStore?.memberReadSeqs['user-3'] === 1)
    chatServiceMock.getOtherMembersReadSeqs.mockClear()

    await emitRevision('member_read_changed', { chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: 4, tombstone: false })
    expect(latestStore?.memberReadSeqs).toEqual({ 'user-2': 4, 'user-3': 1 })
    expect(chatServiceMock.getOtherMembersReadSeqs).not.toHaveBeenCalled()

    // 新消息直接落窗口时同样不能碰成员表:载荷里没有水位
    await emitRevision('message_created', { chat_id: 'chat-1', entity_id: 'arrived', tombstone: false, message: {
      id: 'arrived', chat_id: 'chat-1', sender_user_id: 'user-2', seq: 2, content: 'arrived', content_type: 'text', created_at: '2026-09-15T00:00:02Z',
    } })
    expect(latestStore?.messages.map((m) => m.id)).toContain('arrived')
    expect(latestStore?.memberReadSeqs).toEqual({ 'user-2': 4, 'user-3': 1 })
  })

  it('#6470 the receipt denominator follows membership: a joiner is read in, a known member row update is not, a leaver drops out', async () => {
    serverChatList.mockResolvedValue(chatSnapshot([chat({ id: 'chat-1', name: 'Group', next_message_seq: 2 })]))
    chatServiceMock.getMessages.mockResolvedValueOnce([message({ id: 'before', seq: 1, content: 'before' })])
    chatServiceMock.getOtherMembersReadSeqs.mockResolvedValue({ 'user-2': 1 })
    await renderActiveChat('chat-1')
    await waitForStore(() => latestStore?.memberReadSeqs['user-2'] === 1)
    chatServiceMock.getOtherMembersReadSeqs.mockClear()

    // chat_members 的每一次读水位 UPDATE 也发这条:已在表里的人 ❌ 回读(水位已由 member_read_changed 带值)
    await emitRevision('chat_members_changed', { chat_id: 'chat-1', user_id: 'user-2', tombstone: false })
    expect(chatServiceMock.getOtherMembersReadSeqs).not.toHaveBeenCalled()

    // 新成员 ⇒ 回读一次快照,进分母
    chatServiceMock.getOtherMembersReadSeqs.mockResolvedValueOnce({ 'user-2': 1, 'agent-9': 0 })
    await emitRevision('chat_members_changed', { chat_id: 'chat-1', user_id: 'agent-9', tombstone: false })
    expect(chatServiceMock.getOtherMembersReadSeqs).toHaveBeenCalledTimes(1)
    await waitForStore(() => latestStore?.memberReadSeqs['agent-9'] === 0)

    // 退出 ⇒ 从分母里摘掉,不回读;别的 chat 的成员变动不碰这张表
    await emitRevision('chat_members_changed', { chat_id: 'chat-1', user_id: 'user-2', tombstone: true })
    await emitRevision('chat_members_changed', { chat_id: 'chat-2', user_id: 'user-9', tombstone: false })
    expect(latestStore?.memberReadSeqs).toEqual({ 'agent-9': 0 })
    expect(chatServiceMock.getOtherMembersReadSeqs).toHaveBeenCalledTimes(1)
  })
})
