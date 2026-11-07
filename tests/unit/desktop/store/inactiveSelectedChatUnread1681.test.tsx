// @vitest-environment jsdom
/**
 * #4314 —— 「在对话页新建 agent 之后，概率性不跳转到那个 agent 的会话」。
 *
 * 产品里那一跳的落点是 chat store 的 `activeChatId`：创建流拿到新会话地址后
 * 登记乐观行 + 选中它(这一跳的入口已随对话页创建删掉;选中意图本身仍是 store 的契约)。
 * 「概率性」= 竞态：`open_dm` 写 chat_members 会广播 `chat_members_changed`，
 * 它驱动的那次列表刷新可能**在导航发生之前就发出**、却**在导航之后才落地**；
 * 落地时它的快照里还没有这条新会话，store 于是把用户刚表达的选择清掉。
 *
 * 所以这里用确定性次序把两种排列都钉住（刷新早于导航发出 / 晚于导航发出），
 * 并保留一条真正该撤销的对照，证明断言能判假。
 */
import { act, useEffect, useMemo } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createNode, createReactHarness, displayIdentity, message } from '../../../support/testHarness'
const {
  authUser,
  notificationSettings,
  chatServiceMock,
  openImRepositoryMock,
  readDisplayIdentitiesMock,
  revisionListeners,
  revisionCoordinatorMock,
  publishGate, readMock, host,
} = vi.hoisted(() => ({
  authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
  notificationSettings: { messages: false },
  chatServiceMock: {
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    getThreadMessages: vi.fn(),
    getOtherMembersReadSeqs: vi.fn(),
    fetchMessageOverlays: vi.fn(),
    revalidateWindow: vi.fn(),
    markRead: vi.fn(),
    archiveChat: vi.fn(),
    markUnread: vi.fn(),
    setChatPinned: vi.fn(),
    setChatNotificationLevel: vi.fn(),
    createGroupChat: vi.fn(),
    removeGroupMember: vi.fn(),
  },
  openImRepositoryMock: vi.fn(),
  readDisplayIdentitiesMock: vi.fn(),
  // 一类事件可以有多个认领者(投影、主区那条线……),与真 coordinator 同形:每个都要收到。
  revisionListeners: new Map<string, Set<(operations: readonly unknown[]) => void | Promise<void>>>(),
  revisionCoordinatorMock: {
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(),
    retryPending: vi.fn(),
    whenIdle: vi.fn().mockResolvedValue(undefined),
  },
  publishGate: { current: null as Promise<void> | null },
  readMock: vi.fn(), host: { active: false, listener: null as null | ((active: boolean) => void) },
}))
// Keep row measurement real; bubble rendering and task cards are outside this read boundary.
vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', () => ({ MessageBubble: () => null }))
vi.mock('../../../../apps/desktop/src/components/assistant/TaskExchangeBubble', () => ({ TaskExchangeBubble: () => null }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: authUser, loading: false, setUser: vi.fn() }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {}, getCurrentAuthUserId: async () => authUser.id }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: chatServiceMock }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: readMock,
}))
vi.mock('../../../../apps/desktop/src/lib/chatSnapshotPublication', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/chatSnapshotPublication')>(
    '../../../../apps/desktop/src/lib/chatSnapshotPublication',
  )
  return {
    ...actual,
    publishChatSnapshot: async (...args: Parameters<typeof actual.publishChatSnapshot>) => {
      const gate = publishGate.current
      publishGate.current = null
      if (gate) await gate
      return actual.publishChatSnapshot(...args)
    },
  }
})
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocatorMessages', () => ({
  getUnreadLocatorWindow: vi.fn(),
  getUnreadLocatorMessages: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: readDisplayIdentitiesMock,
  readRequiredDisplayIdentities: readDisplayIdentitiesMock,
}))
vi.mock('../../../../apps/desktop/src/lib/imRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/imRepository')>()
  return { ...actual, openImRepository: openImRepositoryMock }
})
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn(() => ({ userId: 'user-1', eventName: 'message_created', listenerId: 1 })),
  unsubscribeAuthenticatedRealtimeChannel: vi.fn(),
  unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/accountRevisionCoordinator', () => ({
  createAccountRevisionCoordinator: () => revisionCoordinatorMock,
  readRevisionResourceKey: (payload: unknown) => ({
    chatId: (payload as { chat_id?: string }).chat_id ?? '',
    entityId: null,
  }),
}))
// @@@chat-projection 测试替身 —— 这些判据守的是 **store 的行为**(列表反映真值、取数失败要拒绝、
const projectionStub = {
  rows: [] as unknown[],
  identityRows: [] as unknown[],
  revoked: new Set<string>(),
  deleted: new Set<string>(),
  advanceImpl: null as null | (() => Promise<unknown[] | null>),
  reset() {
    projectionStub.rows = []
    projectionStub.identityRows = []
    projectionStub.revoked = new Set()
    projectionStub.deleted = new Set()
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
    confirmPersonalDeletion: ({chat_id}: {chat_id:string}) => { projectionStub.deleted.add(chat_id) },
    hydrate: async () => {
      const snapshot = await serverChatList()
      projectionStub.identityRows = snapshot.identities
      return snapshot.chats
    },
    advance: async () => {
      if (projectionStub.advanceImpl) return projectionStub.advanceImpl()
      return projectionStub.rows
    },
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
    isConversationDeleted: (chatId: string) => projectionStub.deleted.has(chatId),
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
  useNotificationSettings: () => notificationSettings,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { subscribeAppForeground: () => () => {},
    subscribeAppActive: (listener: (active: boolean) => void) => { host.listener = listener; listener(host.active); return () => { host.listener = null } },
    capabilities: { notifications: false, badge: true },
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  },
}))
import { useReportChatOnScreen } from '../../../../apps/desktop/src/lib/onScreenChat'
import { MessageList, type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { ChatProvider } from '../../../../apps/desktop/src/store/chat'
import { useChatStore } from '../../../../apps/desktop/src/store/chatContext'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import type { AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
const AGENT_ID = 'agent-new'
let latestStore: import('../../../../apps/desktop/src/store/chatContext').ChatContextValue | null = null
let harness: ReturnType<typeof createReactHarness> | null = null
let memRepository: AccountImRepository
type ChatsSnapshot = { chats: ChatItem[]; identities: unknown[] }
const existingChat = () => chat({ id: 'chat-1', name: 'Existing', kind: 'dm', peer_user_id: 'peer-1' })
// @@@chat-projection — 「服务端此刻的会话列表」这个缝从 `chatService.getChats` 换成**投影的 hydrate**
const serverChatList = vi.fn<() => Promise<{ chats: unknown[]; identities: unknown[] }>>()
const snapshotWithoutNewChat = (): ChatsSnapshot => ({
  chats: [existingChat()],
  identities: [displayIdentity('peer-1')],
})
let reportVisible = false, useRealList = false
const measuredIds = new Set<string>()
function Probe() {
  latestStore = useChatStore()
  useReportChatOnScreen(latestStore.activeChatId)
  const { messages, markMessageVisible } = latestStore
  // Same dependency boundary as MessageList's measured visibility observer.
  useEffect(() => { if (reportVisible) for (const row of messages) markMessageVisible(row) }, [messages, markMessageVisible])
  const rows = useMemo(() => messages.map(message => ({ type: 'message' as const, message })), [messages])
  const noop = () => undefined
  const rowProps: MessageListRowProps = { rows, messages, mobile: false,
    flashMessageId: null, memberReadSeqs: {}, deliveryWaits: new Map(),
    isGroupChat: false, threeParty: undefined, memberProfiles: {}, onVisible: markMessageVisible,
    onReaction: noop, onShowReadReceipt: undefined, onQuote: noop, onForward: noop, onDelete: noop,
    onOpenMemberProfile: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: null, onAgentFloodUndone: undefined, onOpenFile: undefined,
    onOpenLocalFileLink: undefined, onMentionMember: undefined, selectMode: false,
    selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: undefined }
  return useRealList ? createNode(MessageList, { rows, rowProps }) : null
}
async function flushReact(turns = 6): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
  })
}
async function renderStore(): Promise<void> {
  harness = createReactHarness()
  const Provider = ChatProvider as unknown as (
    props: { active: boolean; children: unknown }
  ) => ReturnType<typeof ChatProvider>
  await harness.render(createNode(Provider, { active: true }, createNode(Probe)))
  await flushReact()
}
beforeEach(async () => {
  authUser.id = 'user-1'
  host.active = false; host.listener = null; reportVisible = false; useRealList = false; measuredIds.clear()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const id = target.getAttribute('data-msg-id')
      if (!id || !measuredIds.has(id)) return
      this.callback([{ target, isIntersecting: true, intersectionRatio: 1,
        intersectionRect: { height: 40, width: 100 }, rootBounds: { height: 400, width: 200 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    unobserve() {} disconnect() {}
  })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true) // native host still wins
  readMock.mockReset().mockResolvedValue(undefined)
  projectionStub.reset()
  publishGate.current = null
  latestStore = null
  harness = null
  revisionListeners.clear()
  revisionCoordinatorMock.subscribe.mockReset()
  revisionCoordinatorMock.subscribe.mockImplementation(
    (events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      const claimed = typeof events === 'string' ? [events] : [...events]
      for (const event of claimed) {
        if (!revisionListeners.has(event)) revisionListeners.set(event, new Set())
        revisionListeners.get(event)!.add(listener)
      }
      return () => { for (const event of claimed) revisionListeners.get(event)?.delete(listener) }
    },
  )
  for (const mock of Object.values(chatServiceMock)) mock.mockReset()
  serverChatList.mockResolvedValue(snapshotWithoutNewChat())
  chatServiceMock.getMessages.mockResolvedValue([])
  chatServiceMock.getOtherMembersReadSeqs.mockResolvedValue({})
  chatServiceMock.getThreadMessages.mockResolvedValue([])
  chatServiceMock.fetchMessageOverlays.mockResolvedValue(new Map())
  chatServiceMock.revalidateWindow.mockImplementation(async (ids: string[]) => ({
    overlays: new Map(), mutations: new Map(), presentIds: new Set(ids),
  }))
  chatServiceMock.markRead.mockResolvedValue(undefined)
  readDisplayIdentitiesMock.mockReset()
  readDisplayIdentitiesMock.mockImplementation(async (ids: readonly string[]) =>
    ids.map((id) => (id === AGENT_ID
      ? displayIdentity(AGENT_ID, { type: 'agent', display_name: '新建的 Agent', owner_user_id: 'user-1' })
      : displayIdentity(id))))
  const actualRepository = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>(
    '../../../../apps/desktop/src/lib/imRepository',
  )
  memRepository = await actualRepository.openImRepository('user-1', {
    adapter: createMemoryLocalSyncDb(),
    storage: window.localStorage,
  })
  openImRepositoryMock.mockReset()
  openImRepositoryMock.mockImplementation(async () => memRepository)
})
afterEach(() => {
  harness?.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})


const tuple = { last_read_seq: 3, read_state_version: 8, unread_count: 2, is_marked_unread: false,
  unread_locator: { stream_id: 'main:chat-1', stream_kind: 'main' as const, thread_root_id: null,
    message_id: 'peer-6', message_seq: 6, unread_count: 2, addressed_count: 1,
    cursor_seq: 3, version: 8, is_marked_unread: false } }
const visible = (seq = 5) => message({ id: `peer-${seq}`, chat_id: 'chat-1', seq,
  sender_user_id: 'peer-1', is_mine: false, thread_root_id: null, to_user_ids: ['user-1'] })
async function open(kind: 'dm' | 'group', rows = [visible()]) {
  const row = chat({ id: 'chat-1', kind, peer_user_id: kind === 'dm' ? 'peer-1' : undefined,
    member_user_ids: ['user-1', 'peer-1'], ...tuple, next_message_seq: 8 })
  serverChatList.mockResolvedValue({ chats: [row], identities: [displayIdentity('peer-1'), displayIdentity('user-1')] })
  await renderStore()
  expect(latestStore!.chats).toHaveLength(1)
  await act(async () => { latestStore!.setActiveChatId('chat-1') })
  await flushReact(20)
  chatServiceMock.getMessages.mockResolvedValue(rows)
  await act(async () => { await latestStore!.refreshMessages('chat-1') })
}
async function activity(active: boolean) {
  host.active = active
  await act(async () => { host.listener?.(active) })
}

it.each(['dm', 'group'] as const)('inactive selected %s ignores real visible rows and preserves a sparse authoritative tuple', async kind => {
  await open(kind)
  await act(async () => { latestStore!.markMessageVisible(visible()) })
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
})
it('active selected group still acknowledges only the visible row with sparse counts intact', async () => {
  await open('group')
  await activity(true)
  await act(async () => { latestStore!.markMessageVisible(visible()) })
  expect(latestStore!.chats[0]).toMatchObject({ ...tuple, last_read_seq: 5, read_state_version: 9 })
  expect(readMock.mock.calls.map(([target]) => target.kind)).toEqual(['main', 'receipt'])
})
// owner 11-05: opening a DM reads all of it; it is never read message by message.
const dmReadWhole = { last_read_seq: 7, read_state_version: 9, unread_count: 0, unread_locator: null, is_marked_unread: false }
it('active selected DM reads to its tail from any visible row and clears the count', async () => {
  await open('dm')
  await activity(true)
  await act(async () => { latestStore!.markMessageVisible(visible()) })
  expect(latestStore!.chats[0]).toMatchObject(dmReadWhole)
  expect(readMock.mock.calls.filter(([target]) => target.kind === 'main').map(([target]) => target.seq)).toEqual([7])
})
it('opening a DM in the foreground reads it whole although its loaded tail is offscreen', async () => {
  useRealList = true; measuredIds.add('peer-5')
  host.active = true
  await open('dm', [visible(5), visible(7)])
  expect(latestStore!.chats[0]).toMatchObject(dmReadWhole)
  expect(readMock.mock.calls.filter(([target]) => target.kind === 'main').map(([target]) => target.seq)).toEqual([7])
})
it('a previously active callback cannot acknowledge after the native host loses activity', async () => {
  await open('dm'); await activity(true)
  const stale = latestStore!.markMessageVisible
  // Same native turn, before React commits the activity change.
  await act(async () => { host.listener?.(false); stale(visible()) })
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
})
it('foregrounding remeasures current visible rows once without a new message or list refresh', async () => {
  await open('group')
  reportVisible = true
  await act(async () => { await latestStore!.refreshMessages('chat-1') })
  expect(readMock).not.toHaveBeenCalled()
  await activity(true)
  expect(latestStore!.chats[0]).toMatchObject({ ...tuple, last_read_seq: 5, read_state_version: 9 })
  expect(readMock).toHaveBeenCalledTimes(2)
  await activity(true)
  expect(readMock).toHaveBeenCalledTimes(2)
})
it('an unopened chat and a previously selected chat are never acknowledged on foregrounding', async () => {
  await open('group')
  await act(async () => { latestStore!.setActiveChatId(null) })
  await activity(true)
  await act(async () => { latestStore!.markMessageVisible(visible()) })
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
})
it('inactive visibility never reverses a newer cross-device read tuple', async () => {
  await open('dm')
  const remote = { ...tuple, last_read_seq: 6, read_state_version: 12, unread_count: 1 }
  await act(async () => { latestStore!.patchChat('chat-1', remote); latestStore!.markMessageVisible(visible(7)) })
  expect(latestStore!.chats[0]).toMatchObject(remote)
  expect(readMock).not.toHaveBeenCalled()
})
it('a self-authored DM row does not acquire an incoming receipt when foregrounded', async () => {
  const own = { ...visible(), is_mine: true, sender_user_id: 'user-1' }
  await open('dm', [own]); await activity(true)
  await act(async () => { latestStore!.markMessageVisible(own) })
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
})

it('real MessageList remeasures a group on foreground and leaves its offscreen loaded tail unread', async () => {
  useRealList = true; measuredIds.add('peer-5')
  await open('group', [visible(5), visible(7)])
  expect(harness!.container.querySelector('[data-msg-id="peer-5"]')).not.toBeNull()
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
  await activity(true)
  expect(latestStore!.chats[0]).toMatchObject({ ...tuple, last_read_seq: 5, read_state_version: 9 })
  expect(readMock.mock.calls.filter(([target]) => target.kind === 'main').map(([target]) => target.seq)).toEqual([5])
  expect(readMock.mock.calls.filter(([target]) => target.kind === 'receipt').map(([target]) => target.messageId)).toEqual(['peer-5'])
  await activity(true)
  expect(readMock).toHaveBeenCalledTimes(2)
})

it.each(['dm', 'group'] as const)('a real visible arrival in inactive %s cannot write either read receipt', async kind => {
  useRealList = true; measuredIds.add('peer-5')
  await open(kind, [])
  chatServiceMock.getMessages.mockResolvedValue([visible(5), visible(7)])
  await act(async () => { await latestStore!.refreshMessages('chat-1') })
  expect(harness!.container.querySelector('[data-msg-id="peer-5"]')).not.toBeNull()
  expect(latestStore!.chats[0]).toMatchObject(tuple)
  expect(readMock).not.toHaveBeenCalled()
})
