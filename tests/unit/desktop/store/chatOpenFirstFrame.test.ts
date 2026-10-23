// @vitest-environment jsdom
// 打开一条会话的第一帧:盘上有这条会话的窗时,选中后**第一次提交**就带着它(不先挂骨架、再卸骨架挂列表);
// 重选当前会话不换视图版本(视图版本是消息列表的 key,一换整个列表重挂、滚动位置重置)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, createElement, useLayoutEffect } from 'react'
import { chat, deferred, message, createReactHarness, renderWithAppProviders, WAIT } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
const msgA1: MessageItem = message({ id: 'msgA1', chat_id: 'chatA', sender_user_id: 'a1', content: 'hello from A' })
const msgB1: MessageItem = message({ id: 'msgB1', chat_id: 'chatB', sender_user_id: 'b1', content: 'hello from B' })
const chatA = chat({ id: 'chatA', kind: 'dm', name: 'Agent A' })
const chatB = chat({ id: 'chatB', kind: 'dm', name: 'Agent B' })
let network = deferred<void>()
let messagesByChat: Record<string, MessageItem[]> = { chatA: [msgA1], chatB: [msgB1] }
const { openImRepositoryMock, revisionListeners, revisionCoordinatorMock } = vi.hoisted(() => ({
  openImRepositoryMock: vi.fn(),
  revisionListeners: new Map<string, Set<(operations: readonly unknown[]) => void | Promise<void>>>(),
  revisionCoordinatorMock: {
    start: vi.fn(), stop: vi.fn(), retryPending: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      const claimed = typeof events === 'string' ? [events] : [...events]
      for (const event of claimed) {
        let listeners = revisionListeners.get(event)
        if (!listeners) revisionListeners.set(event, listeners = new Set())
        listeners.add(listener)
      }
      return () => { for (const event of claimed) revisionListeners.get(event)?.delete(listener) }
    }),
  },
}))
import { createChatProjectionStub, chatProjectionModuleStub } from '../../../support/chatProjectionStub'
// @@@chat-projection — 会话列表只有一个属主:冷启与增量都走投影 ⇒ 测试在**投影这一个缝**上
const projectionStub = createChatProjectionStub()
vi.mock('../../../../apps/desktop/src/lib/chatProjection', () => chatProjectionModuleStub(() => projectionStub))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn(async (chatId: string) => { await network.promise; return messagesByChat[chatId] ?? [] }),
    getThreadMessages: vi.fn(async () => []),
    markRead: vi.fn(async () => {}),
    revalidateWindow: vi.fn(),
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
// #5649 只替换 coordinator 工厂,payload 读取器(readRevisionResourceKey / readMessageCreatedRevision …)用真实现:
// 它们是纯函数,复制一份假的只会在事件多带一个键时悄悄落后于真实现。
vi.mock('../../../../apps/desktop/src/lib/accountRevisionCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/accountRevisionCoordinator')>()),
  createAccountRevisionCoordinator: () => revisionCoordinatorMock,
}))
// 消息窗落盘会顺带补发送者身份;这里不连网。
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => [] }))
vi.mock('../../../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({
  createSupabaseAccountRevisionSource: () => ({}),
}))
const { ChatProvider } = await import('../../../../apps/desktop/src/store/chat')
const { useChatStore } = await import('../../../../apps/desktop/src/store/chatContext')
const { useTopicLine } = await import('../../../../apps/desktop/src/hooks/useTopicLine')
const { chatService } = await import('../../../../apps/desktop/src/lib/chat')
const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
const { replaceMessageWindow } = await import('../../../../apps/desktop/src/lib/imRepository')

type Frame = Pick<ChatContextValue, 'activeChatId' | 'messages' | 'loadingMessages' | 'messageWindow' | 'memberReadSeqs'>
const frames: Frame[] = []
let sharedAccess: ChatContextValue['messageWindows']
function Probe() {
  sharedAccess = useChatStore('messageWindows').messageWindows
  const { activeChatId, messages, loadingMessages, messageWindow, memberReadSeqs } = useChatStore('activeChatId', 'messages', 'loadingMessages', 'messageWindow', 'memberReadSeqs')
  // 记**提交了的**帧(layout 阶段),不是渲染尝试:提交了的才会被画出来。
  useLayoutEffect(() => { frames.push({ activeChatId, messages, loadingMessages, messageWindow, memberReadSeqs }) })
  return null
}
let select: (id: string | null) => void = () => { throw new Error('store not mounted') }
function Selector() {
  select = useChatStore('setActiveChatId').setActiveChatId
  return null
}
let repository: import('../../../../apps/desktop/src/lib/imRepository').AccountImRepository

const scopedFrames: { chatId: string; ids: string[] }[] = []
function ScopedProbe({ chatId }: { chatId: string }) {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const line = useTopicLine(chatId, 'user1', subscribeAccountRevision)
  useLayoutEffect(() => { scopedFrames.push({ chatId, ids: line.messages.map((row) => row.id) }) })
  return null
}
async function mount(extra?: import('react').ReactNode) {
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe), createElement(Selector), extra), { auth: { id: 'user1' } })
  // 仓库打开 = 冷启那一发已落地(会话列表出来了)。
  await vi.waitFor(() => { expect(openImRepositoryMock).toHaveBeenCalled() }, WAIT)
  await act(async () => { await Promise.resolve() })
  frames.length = 0
  return harness
}
const framesOf = (chatId: string) => frames.filter((frame) => frame.activeChatId === chatId)

describe('打开会话的第一帧', () => {
  beforeEach(async () => {
    network = deferred<void>()
    scopedFrames.length = 0
    vi.mocked(chatService.revalidateWindow).mockImplementation(async (ids) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }))
    messagesByChat = { chatA: [msgA1], chatB: [msgB1] }
    revisionListeners.clear()
    projectionStub.reset()
    projectionStub.rows = [chatA, chatB]
    const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>('../../../../apps/desktop/src/lib/imRepository')
    repository = await actual.openImRepository('user1', { adapter: createMemoryLocalSyncDb() })
    openImRepositoryMock.mockReset()
    openImRepositoryMock.mockResolvedValue(repository)
  })

  it('盘上有这条会话的窗:网络还没回,第一帧就画出盘上的内容', async () => {
    await replaceMessageWindow(repository, 'chatA', [msgA1], false)
    const harness = await mount()
    await act(async () => { select('chatA') })
    const first = framesOf('chatA')[0]
    expect(first?.messages.map((row) => row.id)).toEqual(['msgA1'])
    expect(first?.loadingMessages).toBe(false)
    network.resolve()
    harness.cleanup()
  })

  it('重选当前会话:视图版本不变(不整列表重挂)', async () => {
    await replaceMessageWindow(repository, 'chatA', [msgA1], false)
    const harness = await mount()
    await act(async () => { select('chatA') })
    const version = frames.at(-1)?.messageWindow?.viewVersion
    expect(version).toBeTypeOf('number')
    await act(async () => { select('chatA') })
    expect(frames.at(-1)?.messageWindow?.viewVersion).toBe(version)
    network.resolve()
    harness.cleanup()
  })
  it('a topic paints the durable window on its first committed frame without selecting the primary chat', async () => {
    await replaceMessageWindow(repository, 'chatA', [msgA1], false)
    const harness = await mount()
    await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe), createElement(ScopedProbe, { chatId: 'chatA' })), { auth: { id: 'user1' } })
    expect(scopedFrames[0]?.ids).toEqual(['msgA1'])
    expect(frames.every((frame) => frame.activeChatId === null)).toBe(true)
    network.resolve()
    harness.cleanup()
  })

  it('two scopes share publication, persist their fetches and reopen from memory with the network pending', async () => {
    network.resolve()
    const harness = await mount(createElement('div', null, createElement(ScopedProbe, { chatId: 'chatA' }), createElement(ScopedProbe, { chatId: 'chatB' })))
    await vi.waitFor(() => {
      expect(scopedFrames.some((frame) => frame.chatId === 'chatA' && frame.ids.includes('msgA1'))).toBe(true)
      expect(scopedFrames.some((frame) => frame.chatId === 'chatB' && frame.ids.includes('msgB1'))).toBe(true)
    }, WAIT)
    await vi.waitFor(() => expect(repository.snapshot().message.map((row) => row.id).sort()).toEqual(['msgA1', 'msgB1']), WAIT)
    await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe)), { auth: { id: 'user1' } })
    network = deferred<void>()
    scopedFrames.length = 0
    await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe), createElement(ScopedProbe, { chatId: 'chatA' })), { auth: { id: 'user1' } })
    expect(scopedFrames[0]?.ids).toEqual(['msgA1'])
    expect(scopedFrames.every((frame) => frame.chatId === 'chatA' && !frame.ids.includes('msgB1'))).toBe(true)
    network.resolve()
    harness.cleanup()
  })

  it('does not attach the previous chat’s watermarks to bodies painted before the new watermarks arrive', async () => {
    network.resolve()
    const watermarks = deferred<Record<string, number>>()
    vi.mocked(chatService.getOtherMembersReadSeqs).mockImplementation((chatId) => chatId === 'chatA' ? Promise.resolve({ a1: 99 }) : watermarks.promise)
    const harness = await mount()
    try {
      await act(async () => { select('chatA') })
      await vi.waitFor(() => expect(framesOf('chatA').at(-1)?.memberReadSeqs).toEqual({ a1: 99 }), WAIT)
      await act(async () => { select('chatB') })
      await vi.waitFor(() => expect(framesOf('chatB').at(-1)?.messages.map((row) => row.id)).toEqual(['msgB1']), WAIT)
      expect(framesOf('chatB').at(-1)?.memberReadSeqs).toEqual({})
      await act(async () => { watermarks.resolve({ b1: 1 }) })
      expect(framesOf('chatB').at(-1)?.memberReadSeqs).toEqual({ b1: 1 })
    } finally {
      watermarks.resolve({ b1: 1 })
      harness.cleanup()
    }
  })

  it('retains a peer arrival while a secondary cold page is pending', async () => {
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(revisionListeners.has('message_created')).toBe(true), WAIT)
      await act(async () => {
        for (const listener of revisionListeners.get('message_created')!) await listener([{ event: 'message_created', revision: '1', payload: {
          chat_id: 'chatA', entity_id: 'live-2', message: {
            id: 'live-2', chat_id: 'chatA', seq: 2, sender_user_id: 'peer', content: 'arrival', content_type: 'text', created_at: '2026-10-23T00:00:02Z',
          },
        } }])
      })
      expect(sharedAccess.read('chatA')?.map((row) => row.id)).toEqual(['live-2'])
      await act(async () => { network.resolve() })
      await vi.waitFor(() => expect(sharedAccess.read('chatA')?.map((row) => row.id)).toEqual(['msgA1', 'live-2']), WAIT)
    } finally { network.resolve(); harness.cleanup() }
  })

  it('bounds a visible secondary stream and does not crop it to forty on a fresh snapshot', async () => {
    network.resolve()
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(scopedFrames.some((frame) => frame.ids.includes('msgA1'))).toBe(true), WAIT)
      await act(async () => {
        for (let seq = 2; seq <= 200; seq++) sharedAccess.write('chatA', (rows) => [...rows, message({ id: `stream-${seq}`, chat_id: 'chatA', seq })])
      })
      expect(sharedAccess.read('chatA')?.map((row) => row.seq)).toEqual(Array.from({ length: 120 }, (_, index) => index + 81))
      messagesByChat.chatA = Array.from({ length: 40 }, (_, index) => message({ id: `stream-${index + 161}`, chat_id: 'chatA', seq: index + 161 }))
      // A realtime mutator may request persistence from inside the candidate update.
      await act(async () => {
        sharedAccess.write('chatA', (rows) => {
          const candidate = [...rows, message({ id: 'stream-201', chat_id: 'chatA', seq: 201 })]
          sharedAccess.persist('chatA', candidate)
          return candidate
        })
      })
      await vi.waitFor(() => expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA').map((row) => row.value.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, index) => index + 82)), WAIT)
      await act(async () => { await sharedAccess.heal('chatA', true) })
      expect(sharedAccess.read('chatA')?.map((row) => row.seq)).toEqual(Array.from({ length: 120 }, (_, index) => index + 82))
      expect(scopedFrames.at(-1)?.ids).toHaveLength(120)
      await vi.waitFor(() => expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA')).toHaveLength(120), WAIT)
      await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe)), { auth: { id: 'user1' } })
      expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA')).toHaveLength(120)
    } finally { harness.cleanup() }
  })

})
