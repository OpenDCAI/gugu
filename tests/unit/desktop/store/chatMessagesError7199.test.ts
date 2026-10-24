// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskChatScope } from '../../../../apps/desktop/src/components/assistant/TaskChatScope'
import { act, createElement } from 'react'
import { awaitPending } from '../../../support/awaitFact'
import { chat, message, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'

// #7199 读失败交给消息列表说「读不到 + 重试」(❌ 落进首次对话欢迎页)。读失败是**按会话**记的:
// 一条会话迟到的失败 ❌ 盖掉另一条会话此刻的失败;同一条会话里,较早发出、较晚失败的那次 ❌ 盖掉较新的那次成功。

type Deferred = { promise: Promise<MessageItem[]>; resolve: (rows: MessageItem[]) => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<MessageItem[]>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const { openImRepositoryMock, pending } = vi.hoisted(() => ({
  openImRepositoryMock: vi.fn(),
  // 每次 getMessages 按会话排队取一个 deferred,由用例决定它何时、以何种结局落地。
  pending: new Map<string, Deferred[]>(),
}))
function nextDeferred(chatId: string): Deferred {
  const queue = pending.get(chatId) ?? []
  const next = deferred()
  queue.push(next)
  pending.set(chatId, queue)
  return next
}
import { createChatProjectionStub, chatProjectionModuleStub } from '../../../support/chatProjectionStub'
const projectionStub = createChatProjectionStub()
vi.mock('../../../../apps/desktop/src/lib/chatProjection', () => chatProjectionModuleStub(() => projectionStub))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn((chatId: string) => nextDeferred(chatId).promise),
    getThreadMessages: vi.fn(async () => []),
    revalidateWindow: vi.fn(async (ids: string[]) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) })),
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
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn(() => ({ userId: 'test-user', eventName: 'message_created', listenerId: 1 })),
  unsubscribeAuthenticatedRealtimeChannel: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/imRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/imRepository')>()
  return { ...actual, openImRepository: openImRepositoryMock }
})
vi.mock('../../../../apps/desktop/src/lib/accountRevisionCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/accountRevisionCoordinator')>()),
  createAccountRevisionCoordinator: () => ({
    start: vi.fn(), stop: vi.fn(), retryPending: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => () => undefined),
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({
  createSupabaseAccountRevisionSource: () => ({}),
}))
const { ChatProvider } = await import('../../../../apps/desktop/src/store/chat')
const { useChatStore } = await import('../../../../apps/desktop/src/store/chatContext')
const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')

function Probe({ onStore }: { onStore: (s: ChatContextValue) => void }) {
  onStore(useChatStore())
  return null
}
function SurfaceProbe({ mode, onStore }: { mode: string; onStore: (store: ChatContextValue) => void }) {
  const { activeChatId } = useChatStore('activeChatId')
  const probe = createElement(Probe, { onStore })
  return mode === 'block' && activeChatId ? createElement(TaskChatScope, { chatId: activeChatId, children: probe }) : probe
}
async function mount(mode = 'primary') {
  const harness = createReactHarness()
  let cur: ChatContextValue | null = null
  const waiters = new Set<{ ok: (store: ChatContextValue) => boolean; done: () => void }>()
  const onStore = (store: ChatContextValue) => {
    cur = store
    for (const waiter of [...waiters]) {
      if (!waiter.ok(store)) continue
      waiters.delete(waiter)
      waiter.done()
    }
  }
  await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(SurfaceProbe, { mode, onStore })), { auth: { id: 'user1' } })
  const reaches = (step: string, ok: (store: ChatContextValue) => boolean): Promise<void> =>
    cur && ok(cur) ? Promise.resolve() : awaitPending(step, new Promise<void>((done) => { waiters.add({ ok, done }) }))
  await reaches('store ready', () => true)
  return { getStore: () => cur!, reaches }
}
/** 第 index 次对这条会话发出的 getMessages(从 0 数);还没发出就等它发出。 */
async function request(chatId: string, index: number): Promise<Deferred> {
  await awaitPending(`getMessages(${chatId}) #${index} issued`, (async () => {
    while ((pending.get(chatId)?.length ?? 0) <= index) await act(async () => { await Promise.resolve() })
  })())
  return pending.get(chatId)![index]
}

const msgA = message({ id: 'msgA', chat_id: 'chatA', content: 'from A' })

describe.each(['primary', 'block'])('#7199 %s read failures use the account conversation owner', (mode) => {
  beforeEach(async () => {
    pending.clear()
    projectionStub.reset()
    projectionStub.rows = [chat({ id: 'chatA', kind: 'dm', name: 'A' }), chat({ id: 'chatB', kind: 'dm', name: 'B' })]
    const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>('../../../../apps/desktop/src/lib/imRepository')
    openImRepositoryMock.mockReset()
    openImRepositoryMock.mockResolvedValue(await actual.openImRepository('user1', { adapter: createMemoryLocalSyncDb() }))
  })

  it('a late failure of chat A does not replace chat B’s own failure (B stays “couldn’t load”, not empty)', async () => {
    const { getStore, reaches } = await mount(mode)
    await act(async () => { getStore().setActiveChatId('chatA') })
    ;(await request('chatA', 0)).reject(new Error('A open failed'))
    await reaches('A 的读失败交给了消息列表', (store) => store.messagesError?.message === 'A open failed')

    // 在 A 上点了重试,那一发还在路上时人切到了 B。
    let lateRetry: Promise<void> | undefined
    await act(async () => { lateRetry = getStore().refreshMessages('chatA') })
    const retryA = await request('chatA', 1)
    await act(async () => { getStore().setActiveChatId('chatB') })
    ;(await request('chatB', 0)).reject(new Error('B open failed'))
    await reaches('B 的读失败交给了消息列表', (store) => store.activeChatId === 'chatB' && store.messagesError?.message === 'B open failed')

    // A 那一发迟到地失败了:B 此刻的失败照旧(❌ 被 A 的盖掉、B 落成空会话)。
    retryA.reject(new Error('A retry failed late'))
    await act(async () => { await lateRetry!.catch(() => undefined) })
    expect(getStore().activeChatId).toBe('chatB')
    expect(getStore().messagesError?.message).toBe('B open failed')
  })

  it('within one conversation an older retry failing after a newer retry succeeded does not bring the failure back', async () => {
    const { getStore, reaches } = await mount(mode)
    await act(async () => { getStore().setActiveChatId('chatA') })
    ;(await request('chatA', 0)).reject(new Error('A open failed'))
    await reaches('A 的读失败交给了消息列表', (store) => store.messagesError?.message === 'A open failed')

    let older: Promise<void> | undefined
    let newer: Promise<void> | undefined
    await act(async () => { older = getStore().refreshMessages('chatA') })
    const olderRequest = await request('chatA', 1)
    await act(async () => { newer = getStore().refreshMessages('chatA') })
    const newerRequest = await request('chatA', 2)

    newerRequest.resolve([msgA])
    await act(async () => { await newer })
    await reaches('较新的那次读成了', (store) => store.messagesError === null && store.messages.some((row) => row.id === 'msgA'))

    olderRequest.reject(new Error('older retry failed late'))
    await act(async () => { await older!.catch(() => undefined) })
    expect(getStore().messagesError).toBeNull()
    expect(getStore().messages.map((row) => row.id)).toContain('msgA')
  })

  it('positive control: a failure of the conversation on screen is reported, and a successful retry clears it', async () => {
    const { getStore, reaches } = await mount(mode)
    await act(async () => { getStore().setActiveChatId('chatA') })
    ;(await request('chatA', 0)).reject(new Error('A open failed'))
    await reaches('A 的读失败交给了消息列表', (store) => store.messagesError?.message === 'A open failed')
    let retry: Promise<void> | undefined
    await act(async () => { retry = getStore().refreshMessages('chatA') })
    ;(await request('chatA', 1)).resolve([msgA])
    await act(async () => { await retry })
    await reaches('重试成功清掉读失败', (store) => store.messagesError === null)
  })
})

// #2118 会话列表读失败的那一格(通讯录「群」从它判 error):失败了要立起来,换号 / 登出要复位 ——
// ❌ 带着上一个号的 error 闪到下一个号。
describe('chat list load failure flag', () => {
  beforeEach(() => {
    projectionStub.reset()
  })

  it('a failed list read sets chatsLoadFailed, and signing out clears it', async () => {
    projectionStub.hydrateImpl = async () => { throw new Error('list read failed') }
    const harness = createReactHarness()
    const seen: { store: ChatContextValue | null } = { store: null }
    const tree = () => createElement(ChatProvider, null, createElement(Probe, { onStore: (store: ChatContextValue) => { seen.store = store } }))
    const realError = console.error
    console.error = () => undefined
    try {
      await renderWithAppProviders(harness, tree(), { auth: { id: 'user1' } })
      await awaitPending('list read failed', (async () => {
        while (!seen.store?.chatsLoadFailed) await act(async () => { await Promise.resolve() })
      })())
      expect(seen.store!.loadingChats).toBe(false)
      await renderWithAppProviders(harness, tree(), { auth: null })
      await act(async () => { await Promise.resolve() })
      expect(seen.store!.chatsLoadFailed).toBe(false)
    } finally {
      console.error = realError
      harness.cleanup()
    }
  })
})
