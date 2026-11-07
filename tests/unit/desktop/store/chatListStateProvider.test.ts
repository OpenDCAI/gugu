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
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { PatchChat } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { chat, createNode, createReactHarness, deferred, displayIdentity, message } from '../../../support/testHarness'
const {
  authUser,
  notificationSettings,
  chatServiceMock,
  openImRepositoryMock,
  readDisplayIdentitiesMock,
  revisionListeners,
  revisionCoordinatorMock,
  publishGate, readMock, shownBoundary,
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
  readMock: vi.fn(), shownBoundary: { chatId: null as string | null },
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: authUser, loading: false, setUser: vi.fn() }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {}, getCurrentAuthUserId: async () => authUser.id }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: chatServiceMock }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: readMock,
}))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/onScreenChat')>(),
  chatOnScreen: () => shownBoundary.chatId, isChatOnScreen: (id: string) => shownBoundary.chatId === id,
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
    capabilities: { notifications: false, badge: true },
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  },
}))
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
function Probe() {
  latestStore = useChatStore()
  return createNode('div', { 'data-testid': 'probe' })
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
  shownBoundary.chatId = null; readMock.mockReset().mockResolvedValue(undefined)
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
  harness?.cleanup(); vi.restoreAllMocks()
})

// The public context accepts two arguments; its actual root callback is PatchChat.
const patchProviderRead: PatchChat = (id, partial, version) => (latestStore!.patchChat as PatchChat)(id, partial, version)

const readTuple = { last_read_seq: 3, read_state_version: 8, unread_count: 2, is_marked_unread: false,
  unread_locator: { stream_id: 'main:chat-1', stream_kind: 'main' as const, thread_root_id: null,
    message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1,
    cursor_seq: 3, version: 8, is_marked_unread: false } }

it('uses a Provider functional read patch as the basis of an immediate concurrent refresh', async () => {
  await renderStore()
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    await latestStore!.refreshChats()
  })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
})

it('keeps a Provider rollback after a later hidden list refresh', async () => {
  await renderStore()
  await act(async () => {
    latestStore!.patchChat('chat-1', { ...readTuple, last_read_seq: 7, read_state_version: 9, unread_count: 0, unread_locator: null })
    await latestStore!.refreshChats()
    patchProviderRead('chat-1', readTuple, 9)
    await latestStore!.refreshChats()
  })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
})

it('does not apply an older failed-read patch over a newer Provider read tuple', async () => {
  await renderStore()
  const newer = { ...readTuple, last_read_seq: 6, read_state_version: 10, unread_count: 1 }
  await act(async () => {
    latestStore!.patchChat('chat-1', { ...readTuple, last_read_seq: 7, read_state_version: 9, unread_count: 0 })
    latestStore!.patchChat('chat-1', newer)
    patchProviderRead('chat-1', readTuple, 9)
    await latestStore!.refreshChats()
  })
  expect(latestStore!.chats[0]).toMatchObject(newer)
})

it('routes manual unread and its following refresh through the same Provider list', async () => {
  await renderStore()
  chatServiceMock.markUnread.mockResolvedValue({ lastReadSeq: 3, isMarkedUnread: true, version: 11 })
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    await latestStore!.markUnread('chat-1')
  })
  expect(chatServiceMock.markUnread).toHaveBeenCalledExactlyOnceWith('chat-1')
  expect(latestStore!.chats[0]).toMatchObject({ ...readTuple, is_marked_unread: true, read_state_version: 11 })
})

it.each(['pin', 'notifications'] as const)('%s rollback changes only its own fields around a read patch', async kind => {
  await renderStore()
  const request = deferred<void>()
  if (kind === 'pin') chatServiceMock.setChatPinned.mockReturnValue(request.promise)
  else chatServiceMock.setChatNotificationLevel.mockReturnValue(request.promise)
  let pending!: Promise<void>
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    pending = kind === 'pin' ? latestStore!.pinChat('chat-1', true) : latestStore!.setChatNotificationLevel('chat-1', 'none')
  })
  const failure = expect(pending).rejects.toThrow('offline')
  await act(async () => { request.reject(new Error('offline')); await failure })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  if (kind === 'pin') expect(latestStore!.chats[0].is_pinned).toBe(false)
  else expect(latestStore!.chats[0]).toMatchObject({ notification_level: 'all', is_muted: false })
})

it('group creation and optimistic upsert preserve the existing Provider read tuple', async () => {
  await renderStore()
  chatServiceMock.createGroupChat.mockResolvedValue({ chat_id: 'new-group', invitations: [], invitation_errors: [] })
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    await latestStore!.createGroupChat('Group', [])
    latestStore!.upsertChat(chat({ id: 'another-group', kind: 'group', member_user_ids: [] }))
  })
  expect(latestStore!.chats.find(row => row.id === 'chat-1')).toMatchObject(readTuple)
  expect(latestStore!.chats.map(row => row.id)).toEqual(expect.arrayContaining(['new-group', 'another-group']))
})

it('leaving a group removes only that row and preserves another row read tuple', async () => {
  await renderStore()
  chatServiceMock.removeGroupMember.mockResolvedValue(undefined)
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    latestStore!.upsertChat(chat({ id: 'leaving-group', kind: 'group', member_user_ids: [] }))
    await latestStore!.leaveGroup('leaving-group')
  })
  expect(latestStore!.chats.map(row => row.id)).not.toContain('leaving-group')
  expect(latestStore!.chats.find(row => row.id === 'chat-1')).toMatchObject(readTuple)
})

it('logout clears the Provider list owner without retaining a read tuple', async () => {
  await renderStore()
  await act(async () => { latestStore!.patchChat('chat-1', readTuple) })
  await harness!.render(createNode(ChatProvider, { active: false }, createNode(Probe)))
  await flushReact(20)
  expect(latestStore!.chats).toEqual([])
})

it.each(['window', 'visible-row'] as const)('%s read failure stays rolled back through subsequent Provider publications', async mode => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await renderStore()
  await act(async () => { latestStore!.setActiveChatId('chat-1') })
  await flushReact(20)
  const row = message({ id: 'peer-7', chat_id: 'chat-1', seq: 7, is_mine: false, thread_root_id: null })
  const read = deferred<void>(); readMock.mockReturnValueOnce(read.promise)
  await act(async () => { latestStore!.patchChat('chat-1', { ...readTuple, next_message_seq: 8 }) })
  chatServiceMock.getMessages.mockResolvedValue([row])
  await act(async () => { latestStore!.setFollowingTail(true) })
  if (mode === 'window') shownBoundary.chatId = 'chat-1'
  await act(async () => { await latestStore!.refreshMessages('chat-1') })
  if (mode === 'visible-row') {
    shownBoundary.chatId = 'chat-1'
    await act(async () => { latestStore!.markMessageVisible(row) })
  }
  expect(readMock).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'chat-1', seq: 7 })
  // chat-1 is a DM: either read reaches its tail and clears the count (readsWholeChat).
  expect(latestStore!.chats[0]).toMatchObject({ last_read_seq: 7, read_state_version: 9, unread_count: 0 })
  shownBoundary.chatId = null
  await act(async () => { await latestStore!.refreshChats() })
  await act(async () => { read.reject(new Error('offline')); await Promise.resolve() })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  await act(async () => { await latestStore!.refreshChats() })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  expect(readMock).toHaveBeenCalledTimes(1)
  quiet.mockRestore()
})

it('failed manual unread leaves the Provider tuple intact before refreshing', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await renderStore()
  chatServiceMock.markUnread.mockRejectedValue(new Error('offline'))
  await act(async () => {
    latestStore!.patchChat('chat-1', readTuple)
    await latestStore!.markUnread('chat-1')
  })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  quiet.mockRestore()
})

it('does not replay a captured optimistic tuple when the Provider rolls back during repository publication', async () => {
  await renderStore()
  await act(async () => { latestStore!.patchChat('chat-1', { ...readTuple, last_read_seq: 7,
    read_state_version: 9, unread_count: 0, unread_locator: null }) })
  const gate = deferred<void>(); publishGate.current = gate.promise
  let pending!: Promise<void>
  await act(async () => { pending = latestStore!.refreshChats() })
  await flushReact(12)
  await act(async () => { patchProviderRead('chat-1', readTuple, 9) })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  await act(async () => { gate.resolve(); await pending })
  expect(latestStore!.chats[0]).toMatchObject(readTuple)
  const { read_state_version: _transientVersion, ...cachedTuple } = readTuple
  expect(memRepository.snapshot().chat.find(row => row.id === 'chat-1')?.value).toMatchObject(cachedTuple)
})

it('seeds the same Provider owner from a complete cold-cache tuple before the cloud read resolves', async () => {
  const { replaceChatRowsAndIdentities } = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>('../../../../apps/desktop/src/lib/imRepository')
  await replaceChatRowsAndIdentities(memRepository, [{ ...existingChat(), ...readTuple }], [displayIdentity('peer-1')])
  const cloud = deferred<ChatsSnapshot>(); serverChatList.mockReturnValueOnce(cloud.promise)
  await renderStore()
  const { read_state_version: _transientVersion, ...cachedTuple } = readTuple
  expect(latestStore!.chats[0]).toMatchObject(cachedTuple)
  expect(latestStore!.chats[0].read_state_version).toBeUndefined()
  await act(async () => { cloud.resolve({ chats: [{ ...existingChat(), ...readTuple }], identities: [displayIdentity('peer-1')] }); await Promise.resolve() })
  await flushReact(20)
  expect(latestStore!.chats[0]).toMatchObject(cachedTuple)
})

it('an outbound read failure cannot roll back a newer Provider tuple through the wiring forwarder', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await renderStore()
  const read = deferred<void>(); readMock.mockReturnValueOnce(read.promise)
  chatServiceMock.sendMessage.mockImplementation(async (_chat, _sender, _content, id) =>
    message({ id, chat_id: 'chat-1', sender_user_id: 'user-1', seq: 7, is_mine: true, thread_root_id: null }))
  await act(async () => {
    latestStore!.patchChat('chat-1', { ...readTuple, next_message_seq: 8 })
    await latestStore!.sendMessageToChat('chat-1', 'sent', { toUserIds: ['peer-1'] })
  })
  await vi.waitFor(() => expect(readMock).toHaveBeenCalledTimes(1))
  await flushReact(12)
  expect(latestStore!.chats[0]).toMatchObject({ read_state_version: 9, last_read_seq: 7 })
  const newer = { ...readTuple, read_state_version: 12, last_read_seq: 6, unread_count: 1 }
  await act(async () => { latestStore!.patchChat('chat-1', newer) })
  await act(async () => { read.reject(new Error('offline')); await Promise.resolve() })
  expect(latestStore!.chats[0]).toMatchObject(newer)
  quiet.mockRestore()
})
