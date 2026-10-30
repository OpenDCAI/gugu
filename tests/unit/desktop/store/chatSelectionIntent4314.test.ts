// @vitest-environment jsdom
/**
 * #4314 —— 「在对话页新建 agent 之后，概率性不跳转到那个 agent 的会话」。
 *
 * 产品里那一跳的落点是 chat store 的 `activeChatId`：创建流拿到新会话地址后
 * （MainLayout 的 `__GUGU_SESSIONPAGE_MESSAGES__.openAgentChat`）登记乐观行 + 选中它。
 * 「概率性」= 竞态：`open_dm` 写 chat_members 会广播 `chat_members_changed`，
 * 它驱动的那次列表刷新可能**在导航发生之前就发出**、却**在导航之后才落地**；
 * 落地时它的快照里还没有这条新会话，store 于是把用户刚表达的选择清掉。
 *
 * 所以这里用确定性次序把两种排列都钉住（刷新早于导航发出 / 晚于导航发出），
 * 并保留一条真正该撤销的对照，证明断言能判假。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOptimisticAgentChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createNode, createReactHarness, deferred, displayIdentity } from '../../../support/testHarness'
const {
  authUser,
  notificationSettings,
  chatServiceMock,
  openImRepositoryMock,
  readDisplayIdentitiesMock,
  revisionListeners,
  revisionCoordinatorMock,
  publishGate,
} = vi.hoisted(() => ({
  authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
  notificationSettings: { messages: false },
  chatServiceMock: {
    getMessages: vi.fn(),
    getThreadMessages: vi.fn(),
    getOtherMembersReadSeqs: vi.fn(),
    fetchMessageOverlays: vi.fn(),
    revalidateWindow: vi.fn(),
    markRead: vi.fn(),
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
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: authUser, loading: false, setUser: vi.fn() }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {}, getCurrentAuthUserId: async () => authUser.id }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: chatServiceMock }))
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
  useNotificationSettings: () => notificationSettings,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { notifications: false, badge: true },
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  },
}))
import { platform } from '../../../../apps/desktop/src/platform'
import { ChatProvider } from '../../../../apps/desktop/src/store/chat'
import { useChatStore } from '../../../../apps/desktop/src/store/chatContext'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import type { AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
const AGENT_ID = 'agent-new'
const NEW_CHAT_ID = 'chat-agent-new'
let latestStore: import('../../../../apps/desktop/src/store/chatContext').ChatContextValue | null = null
let harness: ReturnType<typeof createReactHarness> | null = null
let memRepository: AccountImRepository
type ChatsSnapshot = { chats: ChatItem[]; identities: unknown[] }
const existingChat = () => chat({ id: 'chat-1', name: 'Existing', kind: 'dm', peer_user_id: 'peer-1' })
const listedAgentChat = () => chat({
  id: NEW_CHAT_ID,
  kind: 'ai',
  name: '',
  peer_user_id: AGENT_ID,
  last_message_at: '2026-08-26T00:00:00.000Z',
})
// @@@chat-projection — 「服务端此刻的会话列表」这个缝从 `chatService.getChats` 换成**投影的 hydrate**
const serverChatList = vi.fn<() => Promise<{ chats: unknown[]; identities: unknown[] }>>()
const snapshotWithoutNewChat = (): ChatsSnapshot => ({
  chats: [existingChat()],
  identities: [displayIdentity('peer-1')],
})
const snapshotWithNewChat = (): ChatsSnapshot => ({
  chats: [listedAgentChat(), existingChat()],
  identities: [
    displayIdentity('peer-1'),
    displayIdentity(AGENT_ID, { type: 'agent', display_name: '新建的 Agent', owner_user_id: 'user-1' }),
  ],
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
/** 产品里那一步：创建流拿到新会话地址后原地进入它（MainLayout 的 openAgentChat 同一序列）。 */
async function openCreatedAgentChat(): Promise<void> {
  await act(async () => {
    latestStore?.upsertChat(createOptimisticAgentChat(NEW_CHAT_ID, AGENT_ID))
    latestStore?.setActiveChatId(NEW_CHAT_ID)
    void latestStore?.refreshChats()
  })
  await flushReact(20)
}
/** open_dm 写 chat_members 时真实会广播的那条 revision（本地不 await，模拟它自己跑）。
 *  载荷与 sync_since 同形:行触发器带 user_id,sync_since 并上 tombstone。 */
function fireMembershipRevision(tombstone = false): void {
  const listeners = revisionListeners.get('chat_members_changed')
  if (!listeners?.size) throw new Error('missing chat_members_changed revision listener')
  const operations = [{ revision: '1', event: 'chat_members_changed', payload: { chat_id: 'chat-1', user_id: 'user-1', tombstone } }]
  for (const listener of listeners) void Promise.resolve(listener(operations)).catch(() => undefined)
}
beforeEach(async () => {
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
  harness?.cleanup()
})
describe('#4314 新建 agent 后的会话选中是导航意图，不是列表刷新的投影', () => {
  it('刷新在导航之前发出、之后落地时不撤销这一跳', async () => {
    await renderStore()
    expect(latestStore?.chats.map((item) => item.id)).toEqual(['chat-1'])
    const stale = deferred<ChatsSnapshot>()
    serverChatList.mockReturnValueOnce(stale.promise)
    await act(async () => {
      fireMembershipRevision()
      await Promise.resolve()
    })
    serverChatList.mockResolvedValue(snapshotWithNewChat())
    await openCreatedAgentChat()
    expect(latestStore?.activeChatId, '创建流刚选中新会话').toBe(NEW_CHAT_ID)
    await act(async () => {
      stale.resolve(snapshotWithoutNewChat())
      await Promise.resolve()
    })
    await flushReact()
    expect(latestStore?.activeChatId, '一次更早发出的刷新不得撤销用户刚做的选择').toBe(NEW_CHAT_ID)
    expect(latestStore?.chats.map((item) => item.id), '被选中的会话必须留在列表里').toContain(NEW_CHAT_ID)
  })
  it('刷新在导航之后发出、服务端投影仍未跟上时不撤销这一跳', async () => {
    await renderStore()
    await openCreatedAgentChat()
    expect(latestStore?.activeChatId).toBe(NEW_CHAT_ID)
    expect(latestStore?.chats.map((item) => item.id), '乐观行与它的对端身份一起落地').toContain(NEW_CHAT_ID)
    await act(async () => {
      fireMembershipRevision()
      await Promise.resolve()
    })
    await flushReact()
    expect(latestStore?.activeChatId, '刷新看不见 ≠ 会话不存在').toBe(NEW_CHAT_ID)
    expect(latestStore?.chats.map((item) => item.id)).toContain(NEW_CHAT_ID)
    serverChatList.mockResolvedValue(snapshotWithNewChat())
    await act(async () => { void latestStore?.refreshChats() })
    await flushReact()
    expect(latestStore?.activeChatId).toBe(NEW_CHAT_ID)
    expect(latestStore?.chats.find((item) => item.id === NEW_CHAT_ID)?.last_message_at)
      .toBe('2026-08-26T00:00:00.000Z')
  })
  it('撤销在落盘期间不得盖掉用户更新的选择', async () => {
    await renderStore()
    await act(async () => { latestStore?.setActiveChatId('chat-1') })
    await flushReact()
    expect(latestStore?.activeChatId).toBe('chat-1')
    serverChatList.mockResolvedValue({
      chats: [listedAgentChat()],
      identities: [displayIdentity(AGENT_ID, { type: 'agent', display_name: '新建的 Agent', owner_user_id: 'user-1' })],
    })
    const publish = deferred<void>()
    publishGate.current = publish.promise
    await act(async () => {
      fireMembershipRevision()
      await Promise.resolve()
    })
    await act(async () => { latestStore?.setActiveChatId(NEW_CHAT_ID) })
    await flushReact()
    await act(async () => {
      publish.resolve()
      await Promise.resolve()
    })
    await flushReact()
    expect(latestStore?.activeChatId, '撤销只能撤掉它自己判过的那条选中').toBe(NEW_CHAT_ID)
  })
  it('对照：真的被移出当前会话时仍然撤销选中', async () => {
    await renderStore()
    await act(async () => { latestStore?.setActiveChatId('chat-1') })
    await flushReact()
    expect(latestStore?.activeChatId).toBe('chat-1')
    projectionStub.advanceImpl = async () => []
    projectionStub.revoked = new Set(['chat-1'])
    await act(async () => {
      fireMembershipRevision(true)
      await Promise.resolve()
    })
    await flushReact()
    expect(latestStore?.activeChatId, '被移出会话时必须让位').toBeNull()
  })
})


describe('system badge follows addressed unread, while list rows stay complete', () => {
  it('keeps a non-addressed group message quiet and badges the next addressed message', async () => {
    serverChatList.mockResolvedValue({ chats: [], identities: [] });
    await renderStore();
    const group = chat({ id: 'badge-group', kind: 'group', unread_count: 5, unread_locator: {
      stream_id: 'main:badge-group', stream_kind: 'main', thread_root_id: null, message_id: 'm1', message_seq: 1,
      unread_count: 5, addressed_count: 0, cursor_seq: 0, version: 1, is_marked_unread: false,
    } });
    await act(async () => { latestStore!.upsertChat(group); });
    await flushReact();
    expect(latestStore!.chats.find((row) => row.id === group.id)?.unread_count).toBe(5);
    expect(platform.setBadge).toHaveBeenLastCalledWith(0);
    await act(async () => { latestStore!.upsertChat({ ...group, unread_count: 6, unread_locator: { ...group.unread_locator!, unread_count: 6, addressed_count: 1 } }); });
    await flushReact();
    expect(platform.setBadge).toHaveBeenLastCalledWith(1);
  });
});
