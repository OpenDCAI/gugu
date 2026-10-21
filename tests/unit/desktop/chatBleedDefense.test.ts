// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, createElement } from 'react'
import { awaitPending } from '../../support/awaitFact'
import { chat, message, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from '../../../apps/desktop/src/store/chatContext'
const msgA1: MessageItem = message({ id: 'msgA1', chat_id: 'chatA', sender_user_id: 'a1', content: 'hello from A' })
const msgB1: MessageItem = message({ id: 'msgB1', chat_id: 'chatB', sender_user_id: 'b1', content: 'hello from B' })
const chatA = chat({ id: 'chatA', kind: 'dm', name: 'Agent A' })
const chatB = chat({ id: 'chatB', kind: 'dm', name: 'Agent B' })
let messagesByChat: Record<string, MessageItem[]> = { chatA: [msgA1], chatB: [msgB1] }
const { openImRepositoryMock, revisionListeners, revisionCoordinatorMock } = vi.hoisted(() => ({
  openImRepositoryMock: vi.fn(),
  revisionListeners: new Map<string, (operations: readonly unknown[]) => void | Promise<void>>(),
  revisionCoordinatorMock: {
    start: vi.fn(), stop: vi.fn(), retryPending: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      const claimed = typeof events === 'string' ? [events] : [...events]
      for (const event of claimed) revisionListeners.set(event, listener)
      return () => { for (const event of claimed) revisionListeners.delete(event) }
    }),
  },
}))
import { createChatProjectionStub, chatProjectionModuleStub } from '../../support/chatProjectionStub'
// @@@chat-projection — 会话列表只有一个属主:冷启与增量都走投影 ⇒ 测试在**投影这一个缝**上
const projectionStub = createChatProjectionStub()
vi.mock('../../../apps/desktop/src/lib/chatProjection', () => chatProjectionModuleStub(() => projectionStub))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn(async (chatId: string) => messagesByChat[chatId] ?? []),
    getThreadMessages: vi.fn(async () => []),
    markRead: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    getMessageById: vi.fn(async () => null),
    fetchMessageOverlays: vi.fn(async () => new Map()),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    archiveChat: vi.fn(async () => {}),
    clearMessagesForMe: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    toggleReaction: vi.fn(async () => {}),
    setChatNotificationLevel: vi.fn(async () => {}),
    setChatPinned: vi.fn(async () => {}),
    createGroupChat: vi.fn(async () => { throw new Error('noop') }),
    _callCountsBySource: {} as Record<string, number>,
  },
}))
vi.mock('../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn(() => ({ userId: 'test-user', eventName: 'message_created', listenerId: 1 })),
  unsubscribeAuthenticatedRealtimeChannel: vi.fn(),
}))
vi.mock('../../../apps/desktop/src/lib/imRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../apps/desktop/src/lib/imRepository')>()
  return { ...actual, openImRepository: openImRepositoryMock }
})
// #5649 只替换 coordinator 工厂,payload 读取器(readRevisionResourceKey / readMessageCreatedRevision …)用真实现:
// 它们是纯函数,复制一份假的只会在事件多带一个键时悄悄落后于真实现。
vi.mock('../../../apps/desktop/src/lib/accountRevisionCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../apps/desktop/src/lib/accountRevisionCoordinator')>()),
  createAccountRevisionCoordinator: () => revisionCoordinatorMock,
}))
vi.mock('../../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({
  createSupabaseAccountRevisionSource: () => ({}),
}))
const { ChatProvider } = await import('../../../apps/desktop/src/store/chat')
const { useChatStore } = await import('../../../apps/desktop/src/store/chatContext')
const { createMemoryLocalSyncDb } = await import('../../../apps/desktop/src/lib/localSyncDb')
function Probe({ onStore }: { onStore: (s: ChatContextValue) => void }) {
  onStore(useChatStore())
  return null
}
async function mount() {
  const harness = createReactHarness()
  let cur: ChatContextValue | null = null
  // store 每变一次 Probe 就渲染一次:等某个状态 = 等到一次满足它的渲染(被测代码自己交出的事实),
  // ❌ 按毫秒轮询、❌ 给它一个墙钟上限。
  const waiters = new Set<{ ok: (store: ChatContextValue) => boolean; done: () => void }>()
  const onStore = (store: ChatContextValue) => {
    cur = store
    for (const waiter of [...waiters]) {
      if (!waiter.ok(store)) continue
      waiters.delete(waiter)
      waiter.done()
    }
  }
  await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe, { onStore })), { auth: { id: 'user1' } })
  const reaches = (step: string, ok: (store: ChatContextValue) => boolean): Promise<void> =>
    cur && ok(cur) ? Promise.resolve() : awaitPending(step, new Promise<void>((done) => { waiters.add({ ok, done }) }))
  await reaches('store ready', () => true)
  return { harness, getStore: () => cur!, reaches }
}
const ids = (store: ChatContextValue) => store.messages.map((m: MessageItem) => m.id)
const idsOf = (getStore: () => ChatContextValue) => ids(getStore())
/**
 * 「写到别的会话的消息没有渗进当前会话」要在 store **处理完那几次写之后**判,❌ 写完当场判(那时还没渲染,判什么都过)。
 * 往当前会话追一条屏障消息、等它画出来:store 的更新按序处理,画出屏障的那一次渲染已经包含它之前的每一次写。
 */
async function barrier(getStore: () => ChatContextValue, reaches: Awaited<ReturnType<typeof mount>>['reaches'], chatId: string) {
  getStore().appendMessage(message({ id: 'render-barrier', chat_id: chatId, seq: -1, content: 'barrier' }))
  await reaches('屏障消息画进当前会话', (store) => ids(store).includes('render-barrier'))
}
describe('#803 chat-bleed defense (store-level)', () => {
  beforeEach(async () => {
    messagesByChat = { chatA: [msgA1], chatB: [msgB1] }
    revisionListeners.clear()
    projectionStub.reset()
    projectionStub.rows = [chatA, chatB]   // 服务端此刻的会话列表
    const actual = await vi.importActual<typeof import('../../../apps/desktop/src/lib/imRepository')>(
      '../../../apps/desktop/src/lib/imRepository',
    )
    const repository = await actual.openImRepository('user1', { adapter: createMemoryLocalSyncDb() })
    openImRepositoryMock.mockReset()
    openImRepositoryMock.mockResolvedValue(repository)
  })
  it('switching chats does not bleed content across chats', async () => {
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatA')
    await reaches('chatA 的消息落地', (store) => ids(store).includes('msgA1'))
    await getStore().setActiveChatId('chatB')
    await reaches('chatB 的消息落地', (store) => ids(store).includes('msgB1'))
    expect(idsOf(getStore)).not.toContain('msgA1') // A's message must NOT bleed into B
  })
  it('applies draft functional updaters to the latest per-chat value atomically', async () => {
    const { getStore } = await mount()
    await act(async () => {
      getStore().setDraft('chatA', 'residual\nnew input')
      getStore().setDraft('chatA', (current) => `earlier message\n${current}`)
    })
    expect(getStore().drafts.chatA).toBe('earlier message\nresidual\nnew input')
  })
  it('Layer 1: a durable revision from another chat is rejected (no pollution)', async () => {
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatB')
    await reaches('chatB 的消息落地', (store) => ids(store).includes('msgB1'))
    const onMessageCreated = revisionListeners.get('message_created')
    expect(onMessageCreated).toBeTypeOf('function')
    const before = getStore().messages.length
    await onMessageCreated?.([{
      revision: '1', event: 'message_created', payload: { chat_id: 'chatA', entity_id: 'msgA2' },
    }])
    expect(idsOf(getStore)).not.toContain('msgA2') // foreign-chat event rejected
    expect(getStore().messages.length).toBe(before) // nothing added
  })
  it('Layer 2+3: poisoned cache (foreign chat_id) sanitized on switch, never painted', async () => {
    messagesByChat = { chatA: [msgA1], chatB: [msgB1, message({ id: 'poison-1', chat_id: 'chatA', content: 'poison' })] }
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatB')
    await reaches('chatB 的消息落地', (store) => ids(store).includes('msgB1'))
    const labeled = getStore().messages.map((m: MessageItem) => `${m.id}:${m.chat_id}`)
    expect(labeled.every((e: string) => !e.endsWith(':chatA'))).toBe(true) // no foreign-chat message painted
  })
  it('Layer 2 (root): appendMessage to a non-active chat derives from that chat cache, not active messages', async () => {
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatA')
    await reaches('chatA 的消息落地', (store) => ids(store).includes('msgA1'))
    getStore().appendMessage(message({ id: 'msgB2', chat_id: 'chatB', content: 'B while A active' }))
    await barrier(getStore, reaches, 'chatA')
    expect(idsOf(getStore)).toContain('msgA1')
    expect(idsOf(getStore)).not.toContain('msgB2') // active chatA not polluted by the chatB write
    await getStore().setActiveChatId('chatB')
    await reaches('chatB 的缓存(含 msgB2)画出来', (store) => ids(store).includes('msgB2'))
    expect(idsOf(getStore)).not.toContain('msgA1')
  })
  it('#831 windowing: entering a chat holds only the window (≤MESSAGE_WINDOW) in memory', async () => {
    const big = Array.from({ length: 250 }, (_, i) => message({
      id: `mA${i}`, chat_id: 'chatA', seq: i, content: `a${i}`,
      created_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }))
    messagesByChat = { chatA: big, chatB: [msgB1] }
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatA')
    await reaches('chatA 的消息落地(最新一条在)', (store) => ids(store).includes('mA249'))
    const n = getStore().messages.length
    expect(n).toBeLessThanOrEqual(200)
    expect(n).toBeGreaterThan(0)
  })
  it('#831 windowing: writes to a non-active chat trim its cache to the window', async () => {
    const { getStore, reaches } = await mount()
    await getStore().setActiveChatId('chatA')
    await reaches('chatA 的消息落地', (store) => ids(store).includes('msgA1'))
    for (let i = 0; i < 250; i += 1) {
      getStore().appendMessage(message({ id: `mB${i}`, chat_id: 'chatB', seq: i, content: `b${i}` }))
    }
    await barrier(getStore, reaches, 'chatA')
    expect(idsOf(getStore)).not.toContain('mB0') // no bleed into active chatA
    await getStore().setActiveChatId('chatB')
    await reaches('chatB 的缓存画出来(最新一条在)', (store) => ids(store).includes('mB249'))
    expect(getStore().messages.length).toBeLessThanOrEqual(200)
  })
})
