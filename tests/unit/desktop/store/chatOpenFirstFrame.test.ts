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
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({ topicService: { archiveTopic: vi.fn(async () => {}) } }))
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
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocatorMessages', () => ({
  getUnreadLocatorWindow: async () => ({ anchorRows: [msgA1], forwardRows: [], reachedTail: true, tailSeq: 1 }),
}))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async (original) => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: vi.fn(async () => {}),
}))
const uploads = vi.hoisted(() => ({ bytes: vi.fn(), commit: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(), attachmentsEndpoint: async () => ({}) }))
vi.mock('@gugu/core/cloud/attachmentsApi', () => ({ uploadAttachmentBytes: uploads.bytes, commitAttachment: uploads.commit }))
const { ChatProvider } = await import('../../../../apps/desktop/src/store/chat')
const { useChatStore } = await import('../../../../apps/desktop/src/store/chatContext')
const { useChatConversation } = await import('../../../../apps/desktop/src/store/useChatConversation')
const { chatService } = await import('../../../../apps/desktop/src/lib/chat')
const { topicService } = await import('../../../../apps/desktop/src/lib/topics')
const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
const { replaceMessageWindow } = await import('../../../../apps/desktop/src/lib/imRepository')

type Frame = Pick<ChatContextValue, 'activeChatId' | 'messages' | 'loadingMessages' | 'messageWindow' | 'memberReadSeqs'>
const frames: Frame[] = []
let sharedAccess: ChatContextValue['conversations']
function Probe() {
  sharedAccess = useChatStore('conversations').conversations
  const { activeChatId, messages, loadingMessages, messageWindow, memberReadSeqs } = useChatStore('activeChatId', 'messages', 'loadingMessages', 'messageWindow', 'memberReadSeqs')
  // 记**提交了的**帧(layout 阶段),不是渲染尝试:提交了的才会被画出来。
  useLayoutEffect(() => { frames.push({ activeChatId, messages, loadingMessages, messageWindow, memberReadSeqs }) })
  return null
}
let select: (id: string | null) => void = () => { throw new Error('store not mounted') }
let listActions: Pick<ChatContextValue, 'chats' | 'deleteChat'>
function Selector() {
  select = useChatStore('setActiveChatId').setActiveChatId
  listActions = useChatStore('chats', 'deleteChat')
  return null
}
let repository: import('../../../../apps/desktop/src/lib/imRepository').AccountImRepository

const scopedLines = new Map<string, ReturnType<typeof useChatConversation>>()
const scopedFrames: { chatId: string; ids: string[] }[] = []
function ScopedProbe({ chatId }: { chatId: string }) {
  const { conversations } = useChatStore('conversations')
  const line = useChatConversation(chatId, conversations)
  scopedLines.set(chatId, line)
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
    vi.mocked(topicService.archiveTopic).mockReset().mockResolvedValue(undefined)
    vi.mocked(chatService.archiveChat).mockClear()
    network = deferred<void>()
    vi.mocked(chatService.getMessages).mockClear().mockImplementation(async (id) => { await network.promise; return messagesByChat[id] ?? [] })
    vi.mocked(chatService.getMessageById).mockResolvedValue(null)
    scopedFrames.length = 0
    scopedLines.clear()
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

  it('keeps a denied topic visible and removes it only after authoritative archival succeeds', async () => {
    network.resolve()
    projectionStub.rows = [{ ...chatA, kind: 'topic', source_chat_id: 'source' }, chatB]
    const harness = await mount()
    try {
      vi.mocked(topicService.archiveTopic).mockRejectedValueOnce(new Error('Only the topic creator can delete it'))
      await act(async () => {
        await expect(listActions.deleteChat('chatA', true)).rejects.toThrow('Only the topic creator')
      })
      expect(listActions.chats.map((row) => row.id)).toContain('chatA')
      expect(chatService.archiveChat).not.toHaveBeenCalled()
      await act(async () => { await listActions.deleteChat('chatA', true) })
      expect(topicService.archiveTopic).toHaveBeenLastCalledWith('chatA')
      expect(listActions.chats.map((row) => row.id)).not.toContain('chatA')
    } finally { harness.cleanup() }
  })

  it('keeps group deletion on the group archival route', async () => {
    network.resolve()
    projectionStub.rows = [{ ...chatA, kind: 'group' }, chatB]
    const harness = await mount()
    try {
      await act(async () => { await listActions.deleteChat('chatA', true) })
      expect(chatService.archiveChat).toHaveBeenCalledWith('chatA')
      expect(topicService.archiveTopic).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
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

  it('uses the current account cache after the committed shell activates effects', async () => {
    await replaceMessageWindow(repository, 'chatA', [msgA1], false)
    const harness = createReactHarness()
    const render = (active: boolean) => renderWithAppProviders(harness,
      createElement(ChatProvider, { active, children: [createElement(Probe, { key: 'probe' }), createElement(Selector, { key: 'selector' })] }), { auth: { id: 'user1' } })
    await render(false)
    await render(true)
    await vi.waitFor(() => expect(openImRepositoryMock).toHaveBeenCalled(), WAIT)
    await act(async () => { select('chatA') })
    expect(framesOf('chatA').at(-1)?.messages.map((row) => row.id)).toEqual(['msgA1'])
    expect(sharedAccess.read('chatA').messageWindow.messages.map((row) => row.id)).toEqual(['msgA1'])
    network.resolve()
    harness.cleanup()
  })

  it('finishes an invalidated first read so unread navigation reaches presentation confirmation', async () => {
    projectionStub.rows = [{ ...chatA, unread_count: 1, unread_locator: { stream_id: 'main:chatA', stream_kind: 'main',
      thread_root_id: null, message_id: 'msgA1', message_seq: 1, unread_count: 1, cursor_seq: 0, version: 0, is_marked_unread: false } }, chatB]
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
    const confirm = vi.fn((event: Event) => {
      const detail = (event as CustomEvent).detail
      detail.confirm(detail.messageId)
    })
    window.addEventListener(UI_EVENTS.openUnreadMessage, confirm)
    let navigation: Promise<void> = Promise.resolve()
    try {
      await vi.waitFor(() => expect(chatService.getMessages).toHaveBeenCalled(), WAIT)
      await act(async () => { select('chatA') })
      await act(async () => { navigation = sharedAccess.actions('chatA').openUnreadChat('chatA') })
      expect(confirm).not.toHaveBeenCalled()
      await act(async () => { network.resolve() })
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce(), WAIT)
      await navigation
      expect(sharedAccess.read('chatA').loading).toBe(false)
    } finally { network.resolve(); window.removeEventListener(UI_EVENTS.openUnreadMessage, confirm); harness.cleanup() }
  })

  it('selects a badged chat even if a hidden explicit scope already owns its reader', async () => {
    network.resolve()
    projectionStub.rows = [{ ...chatA, unread_count: 1, unread_locator: { stream_id: 'main:chatA', stream_kind: 'main',
      thread_root_id: null, message_id: 'msgA1', message_seq: 1, unread_count: 1, cursor_seq: 0, version: 0, is_marked_unread: false } }, chatB]
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(sharedAccess.read('chatA').loading).toBe(false), WAIT)
      await act(async () => { select('chatB') })
      await act(async () => { await sharedAccess.actions(null).openUnreadChat('chatA') })
      expect(frames.at(-1)?.activeChatId).toBe('chatA')
    } finally { harness.cleanup() }
  })

  it('sends from a full off-bottom viewport without cutting off its ACK or reloading the tail', async () => {
    network.resolve()
    projectionStub.rows = [{ ...chatA, kind: 'group' }, chatB]
    const ack = deferred<MessageItem>()
    vi.mocked(chatService.sendMessage).mockImplementation(() => ack.promise)
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(scopedLines.get('chatA')?.messages.length).toBe(1), WAIT)
      await act(async () => {
        for (let seq = 2; seq <= 121; seq++) for (const listener of revisionListeners.get('message_created')!) await listener([{ event: 'message_created', revision: String(seq), payload: {
          chat_id: 'chatA', entity_id: `send-${seq}`, message: { id: `send-${seq}`, chat_id: 'chatA', seq,
            sender_user_id: 'a1', content: 'incoming', content_type: 'text', created_at: new Date().toISOString() },
        } }])
        scopedLines.get('chatA')!.setFollowingTail(false)
      })
      const before = scopedLines.get('chatA')!.messageWindow
      expect(before.messages).toHaveLength(120)
      vi.mocked(chatService.getMessages).mockClear()
      await act(async () => { await scopedLines.get('chatA')!.sendMessage('full-window-send') })
      const pending = scopedLines.get('chatA')!.messageWindow.messages.find((row) => row.content === 'full-window-send')!
      expect(pending).toMatchObject({ seq: -1, local_send_state: 'sending' })
      expect(scopedLines.get('chatA')!.messageWindow).toMatchObject({ hasNewer: false, viewVersion: before.viewVersion,
        navigation: 'latest', navigationVersion: before.navigationVersion + 1 })
      await act(async () => { ack.resolve({ ...pending, seq: 122, local_send_state: undefined }) })
      await vi.waitFor(() => expect(scopedLines.get('chatA')!.messageWindow.messages.at(-1)).toMatchObject({ id: pending.id, seq: 122 }), WAIT)
      expect(scopedLines.get('chatA')!.messageWindow.viewVersion).toBe(before.viewVersion)
      expect(chatService.getMessages).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
  })

  it('shows a topic attachment placeholder at the latest page and removes it when upload fails', async () => {
    network.resolve()
    const all = Array.from({ length: 200 }, (_, index) => message({ id: `att-${index + 1}`, chat_id: 'chatA', seq: index + 1 }))
    vi.mocked(chatService.getMessages).mockImplementation(async (_chat, _user, way, limit = 40, before, after) =>
      way === 'loadOlder' ? all.filter((row) => row.seq < before!).slice(-limit)
        : way === 'loadNewer' ? all.filter((row) => row.seq > after!).slice(0, limit) : all.slice(-40))
    vi.mocked(chatService.getMessageById).mockImplementation(async (id) => all.find((row) => row.id === id) ?? null)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-topic')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const upload = deferred<string>()
    uploads.bytes.mockImplementation(() => upload.promise)
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    let send: Promise<unknown> = Promise.resolve()
    try {
      await vi.waitFor(() => expect(scopedLines.get('chatA')!.messageWindow.messages.at(-1)?.seq).toBe(200), WAIT)
      await act(async () => { await scopedLines.get('chatA')!.loadMessageAnchor('att-20') })
      expect(scopedLines.get('chatA')!.messageWindow.hasNewer).toBe(true)
      await act(async () => { send = scopedLines.get('chatA')!.sendAttachments([new File(['body'], 'topic.txt')]).catch((error) => error) })
      await vi.waitFor(() => expect(scopedLines.get('chatA')!.messageWindow.messages.some((row) => row.seq < 0 && row.content_type === 'attachment')).toBe(true), WAIT)
      expect(scopedLines.get('chatA')!.messageWindow.hasNewer).toBe(false)
      await act(async () => { upload.reject(new Error('upload failed')); await send })
      expect(scopedLines.get('chatA')!.messageWindow.messages.some((row) => row.seq < 0)).toBe(false)
      expect(uploads.commit).not.toHaveBeenCalled()
    } finally { upload.resolve('unused'); harness.cleanup() }
  })

  it('builds the optimistic reply preview from the sending viewport history, outside the account tail', async () => {
    network.resolve()
    const all = Array.from({ length: 200 }, (_, index) => message({ id: `reply-${index + 1}`, chat_id: 'chatA', seq: index + 1, content: `old ${index + 1}` }))
    vi.mocked(chatService.getMessages).mockImplementation(async (_chat, _user, way, limit = 40, before, after) =>
      way === 'loadOlder' ? all.filter((row) => row.seq < before!).slice(-limit)
        : way === 'loadNewer' ? all.filter((row) => row.seq > after!).slice(0, limit) : all.slice(-40))
    vi.mocked(chatService.getMessageById).mockImplementation(async (id) => all.find((row) => row.id === id) ?? null)
    const ack = deferred<MessageItem>()
    vi.mocked(chatService.sendMessage).mockImplementation(() => ack.promise)
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(scopedLines.get('chatA')?.messages.at(-1)?.seq).toBe(200), WAIT)
      await act(async () => { await scopedLines.get('chatA')!.loadMessageAnchor('reply-20') })
      expect(sharedAccess.read('chatA').messageWindow.messages.some((row) => row.id === 'reply-20')).toBe(false)
      await act(async () => { await scopedLines.get('chatA')!.sendMessage('reply from history', { replyToMessageId: 'reply-20' }) })
      const pending = scopedLines.get('chatA')!.messages.find((row) => row.content === 'reply from history')!
      expect(pending).toMatchObject({ local_send_state: 'sending', reply_to_message_id: 'reply-20',
        reply_to_sender_user_id: all[19]!.sender_user_id, reply_to_content: 'old 20' })
      await act(async () => { ack.resolve({ ...pending, seq: 201, local_send_state: null }) })
    } finally { harness.cleanup() }
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
  it('two panes and the primary selection share one reader and one revision owner for the same chat', async () => {
    const harness = await mount(createElement('div', null,
      createElement(ScopedProbe, { chatId: 'chatA' }), createElement(ScopedProbe, { chatId: 'chatA' })))
    await act(async () => { select('chatA') })
    await vi.waitFor(() => expect(chatService.getMessages).toHaveBeenCalledWith('chatA', 'user1', 'initialLoad', expect.any(Number)), WAIT)
    expect(vi.mocked(chatService.getMessages).mock.calls.filter(([id]) => id === 'chatA')).toHaveLength(1)
    // One account-list projection and one conversation consumer, independent of pane count.
    expect(revisionListeners.get('message_created')?.size).toBe(2)
    await act(async () => { network.resolve() })
    await vi.waitFor(() => expect(frames.at(-1)?.messages.map((row) => row.id)).toContain('msgA1'), WAIT)
    expect(frames.at(-1)?.messageWindow).not.toBe(scopedLines.get('chatA')!.messageWindow)
    expect(frames.at(-1)?.messages).toEqual(scopedLines.get('chatA')!.messages)
    expect(scopedLines.get('chatA')!.messages.map((row) => row.id)).toEqual(['msgA1'])
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
    vi.mocked(chatService.getMessages).mockClear().mockImplementation(async (id) => { await network.promise; return messagesByChat[id] ?? [] })
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
      expect(sharedAccess.read('chatA').messageWindow.messages.map((row) => row.id)).toEqual(['live-2'])
      await act(async () => { network.resolve() })
      await vi.waitFor(() => expect(sharedAccess.read('chatA').messageWindow.messages.map((row) => row.id)).toEqual(['msgA1', 'live-2']), WAIT)
    } finally { network.resolve(); harness.cleanup() }
  })

  it('bounds a visible secondary stream and does not crop it to forty on a fresh snapshot', async () => {
    network.resolve()
    const harness = await mount(createElement(ScopedProbe, { chatId: 'chatA' }))
    try {
      await vi.waitFor(() => expect(scopedFrames.some((frame) => frame.ids.includes('msgA1'))).toBe(true), WAIT)
      const emit = async (seq: number) => {
        for (const listener of revisionListeners.get('message_created')!) await listener([{ event: 'message_created', revision: String(seq), payload: {
          chat_id: 'chatA', entity_id: `stream-${seq}`, message: { id: `stream-${seq}`, chat_id: 'chatA', seq,
            sender_user_id: 'a1', content: 'stream', content_type: 'text', created_at: new Date().toISOString() },
        } }])
      }
      await act(async () => { for (let seq = 2; seq <= 201; seq++) await emit(seq) })
      const expected = Array.from({ length: 120 }, (_, index) => index + 82)
      expect(sharedAccess.read('chatA').messageWindow.messages.map((row) => row.seq)).toEqual(expected)
      await vi.waitFor(() => expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA').map((row) => row.value.seq).sort((a, b) => a - b)).toEqual(expected), WAIT)
      messagesByChat.chatA = Array.from({ length: 40 }, (_, index) => message({ id: `stream-${index + 162}`, chat_id: 'chatA', seq: index + 162 }))
      await act(async () => { await sharedAccess.actions('chatA').refreshMessages() })
      expect(sharedAccess.read('chatA').messageWindow.messages.map((row) => row.seq)).toEqual(expected)
      expect(scopedFrames.at(-1)?.ids).toHaveLength(120)
      await vi.waitFor(() => expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA')).toHaveLength(120), WAIT)
      await renderWithAppProviders(harness, createElement(ChatProvider, null, createElement(Probe)), { auth: { id: 'user1' } })
      expect(repository.snapshot().message.filter((row) => row.value.chat_id === 'chatA')).toHaveLength(120)
    } finally { harness.cleanup() }
  })

})
