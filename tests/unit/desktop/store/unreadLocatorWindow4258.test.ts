// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { chat, createNode, createReactHarness, deferred, message as messageItem, waitForCondition } from '../../../support/testHarness'
const {
  authUser,
  setUserMock,
  notificationSettings,
  chatServiceMock,
  getUnreadLocatorWindowMock,
  getUnreadLocatorMessagesMock,
  markStreamReadMock,
  openImRepositoryMock,
  revisionListeners,
  revisionCoordinatorMock,
} = vi.hoisted(() => ({
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
    markMessageRead: vi.fn(async () => {}),
    markRead: vi.fn(),
    markThreadRoot: vi.fn(),
  },
  getUnreadLocatorWindowMock: vi.fn(),
  getUnreadLocatorMessagesMock: vi.fn(),
  markStreamReadMock: vi.fn(),
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
import { createChatProjectionStub, chatProjectionModuleStub } from '../../../support/chatProjectionStub'
// @@@chat-projection — 冷启快照也走投影 ⇒ 「服务端此刻的列表」在投影这一个缝上表达,
const projectionStub = createChatProjectionStub()
vi.mock('../../../../apps/desktop/src/lib/chatProjection', () => chatProjectionModuleStub(() => projectionStub))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: authUser, loading: false, setUser: setUserMock }),
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: chatServiceMock }))
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocatorMessages', () => ({
  getUnreadLocatorWindow: getUnreadLocatorWindowMock,
  getUnreadLocatorMessages: getUnreadLocatorMessagesMock,
}))
vi.mock('../../../../apps/desktop/src/lib/chatMemberReadState', () => ({
  markStreamRead: markStreamReadMock,
  markMemberRead: vi.fn(),
  markMemberUnread: vi.fn(),
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
  readRevisionResourceKey: (payload: unknown) => ({ chatId: (payload as { chat_id: string }).chat_id, entityId: null }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({
  createSupabaseAccountRevisionSource: () => ({}),
}))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({
  useNotificationSettings: () => notificationSettings,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { capabilities: { notifications: false, badge: false }, showNotification: vi.fn(), setBadge: vi.fn() },
}))
import { ChatProvider } from '../../../../apps/desktop/src/store/chat'
import { useChatStore } from '../../../../apps/desktop/src/store/chatContext'
import { useReportChatOnScreen } from '../../../../apps/desktop/src/lib/onScreenChat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { UNREAD_LOCATOR_ANCHOR_PAGE, UNREAD_LOCATOR_FORWARD_PAGE } from '../../../../apps/desktop/src/lib/chatUnreadLocatorWindow'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { UnreadMessageRevealRequest } from '../../../../apps/desktop/src/lib/chatUnreadLocator'
const CHAT_ID = 'chat-1'
const ROOT_A = '11111111-1111-4111-8111-111111111111'
const ROOT_B = '22222222-2222-4222-8222-222222222222'
let latestStore: import('../../../../apps/desktop/src/store/chatContext').ChatContextValue | null = null
let harness: ReturnType<typeof createReactHarness> | null = null
let memRepository: AccountImRepository
let serverRows: MessageItem[] = []
let serverMainReadSeq = 0
let serverThreadReadSeq = new Map<string, number>()
let readStateVersion = 0
let revealedRequests: UnreadMessageRevealRequest[] = []
const threadStreamId = (rootId: string) => `thread:${CHAT_ID}:${rootId}`
function peerRow(seq: number, overrides: Partial<MessageItem> = {}): MessageItem {
  return messageItem({
    id: `m${seq}`,
    chat_id: CHAT_ID,
    sender_user_id: 'peer-1',
    to_user_ids: ['user-1'],
    seq,
    content: `msg-${seq}`,
    ...overrides,
  })
}
const mainRows = () => serverRows.filter((row) => row.thread_root_id == null)
const rowsOfThread = (rootId: string) => serverRows.filter((row) => row.id === rootId || row.thread_root_id === rootId)
type Projection = { locator: ChatUnreadLocator | null; count: number }
function projectStream(
  streamRows: readonly MessageItem[],
  cursor: number,
  stream: Pick<ChatUnreadLocator, 'stream_id' | 'stream_kind' | 'thread_root_id'>,
): Projection {
  const unread = streamRows.filter((row) => (
    row.seq > cursor
    && row.sender_user_id !== authUser.id
    && (stream.stream_kind === 'main' || row.thread_root_id != null)
  ))
  const first = unread[0]
  if (!first) return { locator: null, count: 0 }
  return {
    count: unread.length,
    locator: {
      ...stream,
      message_id: first.id,
      message_seq: first.seq,
      unread_count: unread.length,
      cursor_seq: cursor,
      version: readStateVersion,
      is_marked_unread: false,
    },
  }
}
const mainProjection = (): Projection => projectStream(mainRows(), serverMainReadSeq, {
  stream_id: `main:${CHAT_ID}`, stream_kind: 'main', thread_root_id: null,
})
const threadProjection = (rootId: string) => (): Projection => projectStream(
  rowsOfThread(rootId), serverThreadReadSeq.get(threadStreamId(rootId)) ?? 0,
  { stream_id: threadStreamId(rootId), stream_kind: 'thread', thread_root_id: rootId },
)
let projection: () => Projection = mainProjection
function chatRow(): ChatItem {
  const { locator, count } = projection()
  return chat({
    id: CHAT_ID,
    kind: 'group',
    name: 'Agent chat',
    last_read_seq: serverMainReadSeq,
    next_message_seq: (serverRows.at(-1)?.seq ?? 0) + 1,
    unread_count: count,
    unread_locator: locator,
    read_state_version: readStateVersion,
  })
}
// 替身壳:选中的会话默认摆在屏幕上;offScreen 模拟退回列表/切 tab/切后台。
const shell = { offScreen: false, rerender: () => {} }
function Probe() {
  latestStore = useChatStore()
  const [, bump] = useState(0)
  shell.rerender = () => bump((n) => n + 1)
  useReportChatOnScreen(shell.offScreen ? null : latestStore.activeChatId)
  const { activeChatId, setFollowingTail } = latestStore
  const onScreen = !shell.offScreen
  useEffect(() => { setFollowingTail(onScreen) }, [activeChatId, setFollowingTail, onScreen])
  return createNode('div', { 'data-testid': 'probe' })
}
async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function renderProvider() {
  harness = createReactHarness()
  await harness.render(createNode(ChatProvider, null, createNode(Probe)))
  await flushReact()
  await waitForCondition(() => (latestStore?.chats.length ?? 0) > 0, 'chat list never loaded')
}
let pendingReveals: UnreadMessageRevealRequest[] = []
function onRevealRequested(event: Event): void {
  const detail = (event as CustomEvent<UnreadMessageRevealRequest>).detail
  revealedRequests.push(detail)
  pendingReveals.push(detail)
}
function streamRowsInStore(request: UnreadMessageRevealRequest): readonly MessageItem[] {
  return (request.streamKind === 'main' ? latestStore?.messages : latestStore?.threadMessages) ?? []
}
async function settleLocatorOpen(promise: Promise<void>): Promise<void> {
  let settled = false
  const tracked = promise.then(() => { settled = true }, (error: unknown) => { settled = true; throw error })
  void tracked.catch(() => undefined)
  for (let step = 0; step < 60 && !settled; step += 1) {
    await flushReact()
    for (let index = pendingReveals.length - 1; index >= 0; index -= 1) {
      const request = pendingReveals[index]
      if (request.streamKind === 'main' && request.commit) {
        await act(async () => { await latestStore!.loadMessageAnchor(request.messageId, request.commit) })
      }
      if (streamRowsInStore(request).some((row) => row.id === request.messageId)) {
        pendingReveals.splice(index, 1)
        request.confirm(request.messageId)
      }
    }
  }
  for (const request of pendingReveals.splice(0)) {
    request.reject(new Error(`locator row ${request.messageId} never entered the ${request.streamKind} row set`))
  }
  if (!settled) await flushReact()
  return tracked
}
beforeEach(async () => {
  latestStore = null
  shell.offScreen = false
  harness = null
  revealedRequests = []
  pendingReveals = []
  window.addEventListener(UI_EVENTS.openUnreadMessage, onRevealRequested)
  serverMainReadSeq = 0
  serverThreadReadSeq = new Map()
  readStateVersion = 0
  projection = mainProjection
  revisionListeners.clear()
  revisionCoordinatorMock.subscribe.mockReset()
  revisionCoordinatorMock.subscribe.mockImplementation(
    (events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      const claimed = typeof events === 'string' ? [events] : [...events]
      for (const event of claimed) revisionListeners.set(event, listener)
      return () => { for (const event of claimed) revisionListeners.delete(event) }
    },
  )
  for (const mock of Object.values(chatServiceMock)) if (typeof mock === 'object' && 'mockReset' in mock) (mock as { mockReset: () => void }).mockReset()
  getUnreadLocatorWindowMock.mockReset()
  getUnreadLocatorMessagesMock.mockReset()
  markStreamReadMock.mockReset()
  projectionStub.reset()
  projectionStub.hydrateImpl = async () => [chatRow()]
  projectionStub.advanceImpl = async () => [chatRow()]
  chatServiceMock.getOtherMembersReadSeqs.mockResolvedValue({})
  chatServiceMock.getThreadMessages.mockImplementation(async (_chatId: string, rootId: string) => rowsOfThread(rootId))
  chatServiceMock.fetchMessageOverlays.mockResolvedValue(new Map())
  chatServiceMock.revalidateWindow.mockImplementation(async (ids: string[]) => ({
    overlays: new Map(), mutations: new Map(), presentIds: new Set(ids),
  }))
  // chat.mark_read 与 mark_stream_read 写的是同一个主线水位(服务端单调取大)。
  chatServiceMock.markRead.mockImplementation(async (_chatId: string, seq: number) => { serverMainReadSeq = Math.max(serverMainReadSeq, seq) })
  chatServiceMock.markThreadRoot.mockResolvedValue(undefined)
  chatServiceMock.getMessages.mockImplementation(
    async (chatId: string, _userId: string, _source: string, limit = 60, beforeSeq?: number, afterSeq?: number) => {
      const rows = mainRows().filter((row) => row.chat_id === chatId)
      if (typeof afterSeq === 'number') return rows.filter((row) => row.seq > afterSeq).slice(0, limit)
      if (typeof beforeSeq === 'number') return rows.filter((row) => row.seq < beforeSeq).slice(-limit)
      return rows.slice(-limit)
    },
  )
  const streamRowsFor = (locator: ChatUnreadLocator) => (
    locator.stream_kind === 'main' ? mainRows() : rowsOfThread(locator.thread_root_id ?? '')
  )
  getUnreadLocatorWindowMock.mockImplementation(
    async (_chatId: string, locator: ChatUnreadLocator, _userId: string, pages: { anchor?: number; forward?: number } = {}) => {
      const rows = streamRowsFor(locator)
      const forwardLimit = pages.forward ?? UNREAD_LOCATOR_FORWARD_PAGE
      const forwardRows = rows.filter((row) => row.seq > (locator.message_seq ?? 0)).slice(0, forwardLimit)
      return {
        anchorRows: rows.filter((row) => row.seq <= (locator.message_seq ?? 0)).slice(-(pages.anchor ?? UNREAD_LOCATOR_ANCHOR_PAGE)),
        forwardRows,
        reachedTail: forwardRows.length < forwardLimit,
        // @@@6089 与产品一致:尾部是这条 stream 对本人可见的最大 seq,与窗口取到哪儿无关。
        tailSeq: rows.length > 0 ? Math.max(...rows.map((row) => row.seq)) : (locator.message_seq ?? 0),
      }
    },
  )
  getUnreadLocatorMessagesMock.mockImplementation(
    async (_chatId: string, locator: ChatUnreadLocator, _userId: string, limit = UNREAD_LOCATOR_ANCHOR_PAGE) =>
      streamRowsFor(locator).filter((row) => row.seq <= (locator.message_seq ?? 0)).slice(-limit),
  )
  markStreamReadMock.mockImplementation(async (_chatId: string, streamId: string, seq: number) => {
    readStateVersion += 1
    if (streamId.startsWith('thread:')) {
      serverThreadReadSeq.set(streamId, Math.max(serverThreadReadSeq.get(streamId) ?? 0, seq))
    } else serverMainReadSeq = Math.max(serverMainReadSeq, seq)
    return { streamId, lastReadSeq: seq, isMarkedUnread: false, version: readStateVersion }
  })
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/imRepository')>(
    '../../../../apps/desktop/src/lib/imRepository',
  )
  memRepository = await actual.openImRepository('user-1', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
  openImRepositoryMock.mockReset()
  openImRepositoryMock.mockImplementation(async () => memRepository)
})
afterEach(() => {
  window.removeEventListener(UI_EVENTS.openUnreadMessage, onRevealRequested)
  harness?.cleanup()
  harness = null
})
async function setChatOnScreen(onScreen: boolean): Promise<void> {
  shell.offScreen = !onScreen
  await act(async () => { shell.rerender() })
}
describe('#6610 arrival only reads the selected chat while it is on screen', () => {
  it('leaves rows that land while the selected chat is off screen unread, and reads them once it is back', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 11
    await renderProvider()
    await act(async () => { latestStore!.setActiveChatId(CHAT_ID) })
    await waitForCondition(() => (latestStore?.messages.length ?? 0) === 11, 'selected chat never loaded')

    await setChatOnScreen(false)
    serverRows = [...serverRows, peerRow(12), peerRow(13)]
    await act(async () => { await latestStore!.refreshChats() })
    chatServiceMock.markRead.mockClear()
    await act(async () => { await latestStore!.refreshMessages(CHAT_ID) })
    expect(latestStore!.messages.at(-1)?.seq, 'the new rows did land in the selected chat').toBe(13)
    expect(chatServiceMock.markRead, 'off screen: arriving is not reading').not.toHaveBeenCalled()
    expect(latestStore!.chats[0]?.unread_count).toBe(2)

    // 阳性对照:同一场景只差「回到屏幕上」,同一次重拉照旧推到尾部。
    await setChatOnScreen(true)
    await act(async () => { await latestStore!.refreshMessages(CHAT_ID) })
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith(CHAT_ID, 13)
  })
})
// @@@6530 列表点开有未读的会话:停在最新处、尾部对账落定时清零;第一条未读留给「↑ N 条新消息」。
async function openBadgedChat(): Promise<void> {
  await act(async () => { await latestStore!.openUnreadChat(CHAT_ID) })
  await waitForCondition(() => latestStore?.chats[0]?.unread_count === 0 && (latestStore?.messages.length ?? 0) > 0, 'opening never settled at the latest window')
}
describe('#6530 opening a badged chat lands on the latest message (WeChat)', () => {
  it('opens at the tail, clears the badge, and keeps the first unread for the pill', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    await renderProvider()
    await openBadgedChat()
    expect(revealedRequests, '打开不跳到第一条未读').toEqual([])
    expect(latestStore?.messages.at(-1)?.seq).toBe(11)
    expect(chatServiceMock.markRead).toHaveBeenLastCalledWith(CHAT_ID, 11)
    expect(serverMainReadSeq).toBe(11)
    expect(latestStore?.chats[0]?.unread_locator).toBeNull()
    expect(latestStore?.unreadEntry?.locator).toMatchObject({ message_id: 'm10', message_seq: 10, unread_count: 2 })
  })
  it('clears a backlog larger than a page on open, and the entry dies once the chat is left', async () => {
    const total = UNREAD_LOCATOR_FORWARD_PAGE * 2 + 20
    serverRows = Array.from({ length: total }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 5
    await renderProvider()
    await openBadgedChat()
    expect(serverMainReadSeq, '#6089 点开就清:水位到尾部').toBe(total)
    expect(latestStore?.messageWindow?.hasNewer).toBe(false)
    expect(latestStore?.unreadEntry?.locator.message_id).toBe('m6')
    await act(async () => { latestStore!.setActiveChatId(null) })
    await act(async () => { latestStore!.setActiveChatId(CHAT_ID) })
    expect(latestStore?.unreadEntry, '离开再回来(已读)不再提示').toBeNull()
  })
})
// 下面这些用例的定位路径现在由「↑ N 条新消息」触发(主线)或列表直接触发(话题流未读)。
describe('#4258 jumping to the unread locator', () => {
  it('consumes the entry as soon as presentation confirms, before the read RPC settles', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    await renderProvider()
    await openBadgedChat()
    const read = deferred()
    markStreamReadMock.mockImplementationOnce(() => read.promise)
    let jump!: Promise<void>, finished = false
    await act(async () => { jump = latestStore!.jumpToUnreadEntry(); void jump.then(() => { finished = true }) })
    await waitForCondition(() => pendingReveals.length === 1, 'unread presenter was not requested')
    await act(async () => { pendingReveals.shift()!.confirm('m10') })
    expect(markStreamReadMock).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    expect(latestStore!.unreadEntry).toBeNull()
    await act(async () => { read.resolve(undefined); await jump })
  })

  it('keeps the entry available when presentation fails', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    await renderProvider()
    await openBadgedChat()
    const entry = latestStore!.unreadEntry
    let jump!: Promise<void>
    await act(async () => { jump = latestStore!.jumpToUnreadEntry(); void jump.catch(() => {}) })
    await waitForCondition(() => pendingReveals.length === 1, 'unread presenter was not requested')
    await act(async () => { pendingReveals.shift()!.reject(new Error('Target was not shown')) })
    await expect(jump).rejects.toThrow('Target was not shown')
    expect(latestStore!.unreadEntry).toBe(entry)
    expect(markStreamReadMock).not.toHaveBeenCalled()
  })

  it('does not consume a newer captured entry when an earlier presenter confirms', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    chatServiceMock.markRead.mockImplementation(async (_chatId: string, seq: number) => {
      if (seq > serverMainReadSeq) readStateVersion += 1
      serverMainReadSeq = Math.max(serverMainReadSeq, seq)
    })
    await renderProvider()
    await openBadgedChat()
    let jump!: Promise<void>
    await act(async () => { jump = latestStore!.jumpToUnreadEntry() })
    await waitForCondition(() => pendingReveals.length === 1, 'unread presenter was not requested')
    await act(async () => { latestStore!.setFollowingTail(false) })
    expect(serverMainReadSeq).toBe(11)
    serverRows = [...serverRows, peerRow(12)]
    await act(async () => { await latestStore!.refreshChats() })
    expect(serverMainReadSeq).toBe(11)
    expect(latestStore!.chats[0]?.unread_locator?.message_id).toBe('m12')
    await act(async () => { await latestStore!.openUnreadChat(CHAT_ID, false) })
    const entry = latestStore!.unreadEntry
    expect(entry?.locator.message_id).toBe('m12')
    await act(async () => { pendingReveals.shift()!.confirm('m10'); await jump })
    expect(latestStore!.unreadEntry).toBe(entry)
  })

  it('keeps two same-chat viewport requests current until each presenter confirms', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    await renderProvider()
    await openBadgedChat()
    const a = document.createElement('div'), b = document.createElement('div')
    let first!: Promise<void>, second!: Promise<void>
    await act(async () => {
      first = latestStore!.jumpToUnreadEntry(a)
      second = latestStore!.jumpToUnreadEntry(b)
      await Promise.resolve()
    })
    await waitForCondition(() => revealedRequests.length === 2, 'both viewport requests did not reach presentation')
    expect(revealedRequests.map((request) => request.viewport)).toEqual([a, b])
    expect(revealedRequests.every((request) => request.isCurrent?.())).toBe(true)
    await act(async () => {
      for (const request of pendingReveals.splice(0)) request.confirm(request.messageId)
      await Promise.all([first, second])
    })
    expect(markStreamReadMock).toHaveBeenCalledTimes(2)
  })

  it('leaves no unread message outside the rendered window when the badge reads 2', async () => {
    serverRows = Array.from({ length: 11 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 9
    await renderProvider()
    expect(latestStore?.chats[0]?.unread_count).toBe(2)
    expect(latestStore?.chats[0]?.unread_locator?.message_id).toBe('m10')
    await openBadgedChat()
    await settleLocatorOpen(latestStore!.jumpToUnreadEntry())
    const renderedSeqs = latestStore?.messages.map((row) => row.seq) ?? []
    const committedSeq = markStreamReadMock.mock.calls.at(-1)?.[2]
    expect(renderedSeqs).toContain(10)
    expect(renderedSeqs).toContain(11)
    expect(committedSeq).toBe(11)
    expect(serverMainReadSeq).toBe(11)
    expect(latestStore?.chats[0]?.unread_count).toBe(0)
    expect(latestStore?.chats[0]?.unread_locator).toBeNull()
    expect(revealedRequests.map((request) => request.messageId)).toEqual(['m10'])
  })
  // @@@6089 —— 这条用例此前编码的是相反的合同(「cursor 绝不越过窗口」),于是积压超过一个 forward 页时
  // 一次打开只清 `锚点+60`,剩下的照旧挂在角标上。owner 真机读数:70 条未读点开后仍剩 9。
  // 产品合同是 #5295「点开就清」+ product spec「有未读…必清零」⇒ cursor 走 stream 尾部。
  // 窗口仍然有界(渲染约束),够不到尾部由 `hasNewer` 如实上报 —— 消息区据此给出「返回最新」。
  it('clears the whole backlog on open while keeping the rendered window bounded', async () => {
    const total = UNREAD_LOCATOR_FORWARD_PAGE * 2 + 20
    serverRows = Array.from({ length: total }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 5
    await renderProvider()
    await openBadgedChat()
    await settleLocatorOpen(latestStore!.jumpToUnreadEntry())
    const renderedSeqs = latestStore?.messages.map((row) => row.seq) ?? []
    const committedSeq = markStreamReadMock.mock.calls.at(-1)?.[2] as number

    expect(committedSeq, '水位提交到 stream 尾部').toBe(total)
    expect(serverMainReadSeq).toBe(total)
    expect(latestStore?.chats[0]?.unread_count, '打开即清零').toBe(0)
    expect(latestStore?.chats[0]?.unread_locator).toBeNull()
    // 窗口没有跟着无限长:它仍然停在「锚点 + 一个 forward 页」。
    expect(Math.max(...renderedSeqs)).toBe(6 + UNREAD_LOCATOR_FORWARD_PAGE)
    expect(latestStore?.messageWindow?.hasNewer, '够不到尾部必须如实说,否则「返回最新」这个出口就没了').toBe(true)
  })
  // @@@6089 —— 打开之后仍有未读的**唯一**来源是「打开之后新到的消息」(打开那一刻的积压已被清零)。
  // 这条用例守的三件事没变:①窗口离开尾部时一次权威重拉不许把水位拽到尾部(#6047 的 isFollowingTail 闸);
  // ②只有真的被看见的那一行才推水位,且不许抹掉服务端为后面几页留的 locator;③跨 chat 的行不推本会话的水位。
  it('keeps the watermark off the live tail until a row is actually visible', async () => {
    serverRows = Array.from({ length: 160 }, (_, index) => peerRow(index + 1))
    serverMainReadSeq = 5
    await renderProvider()
    await openBadgedChat()
    await settleLocatorOpen(latestStore!.jumpToUnreadEntry())
    expect(latestStore!.messageWindow?.hasNewer).toBe(true)
    expect(latestStore!.chats[0]?.unread_count, '#6089 打开即清零').toBe(0)
    expect(serverMainReadSeq).toBe(160)
    const boundedTop = Math.max(...latestStore!.messages.map((row) => row.seq))

    serverRows = [...serverRows, ...Array.from({ length: 40 }, (_, index) => peerRow(161 + index))]
    await act(async () => { await latestStore!.refreshChats() })
    expect(latestStore!.chats[0]?.unread_count, '打开之后新到的 40 条重新攒成未读').toBe(40)

    chatServiceMock.markRead.mockClear()
    await act(async () => { await latestStore!.refreshMessages(CHAT_ID) })
    expect(chatServiceMock.markRead, '窗口离开尾部时重拉不许推水位').not.toHaveBeenCalled()
    expect(latestStore!.chats[0]?.unread_count).toBe(40)
    expect(Math.max(...latestStore!.messages.map((row) => row.seq)), '有界窗口不被重拉换成 live tail')
      .toBe(boundedTop)

    await act(async () => { await latestStore!.returnToLatestMessages() })
    chatServiceMock.markRead.mockClear()
    const visible = latestStore!.messages.find((row) => row.seq === 200)!
    expect(visible).toBeDefined()
    await act(async () => { latestStore!.markMessageVisible(visible) })
    expect(chatServiceMock.markRead).toHaveBeenCalledWith(CHAT_ID, 200)
    expect(latestStore!.chats[0]?.unread_locator, '读一页不许抹掉服务端为后面几页留的 locator').not.toBeNull()

    await act(async () => { latestStore!.markMessageVisible({ ...visible, chat_id: 'another-chat', seq: 999 }) })
    expect(chatServiceMock.markRead).toHaveBeenCalledTimes(1)
  })
  it('applies the same window rule to a thread stream', async () => {
    serverRows = [
      peerRow(1, { id: ROOT_A, is_thread_root: true }),
      peerRow(2, { id: 'reply-a1', thread_root_id: ROOT_A }),
      peerRow(3, { id: 'reply-a2', thread_root_id: ROOT_A }),
    ]
    projection = threadProjection(ROOT_A)
    serverThreadReadSeq.set(threadStreamId(ROOT_A), 1)
    await renderProvider()
    expect(latestStore?.chats[0]?.unread_count).toBe(2)
    await settleLocatorOpen(latestStore!.openUnreadChat(CHAT_ID))
    expect(latestStore?.threadMessages.map((row) => row.id)).toEqual([ROOT_A, 'reply-a1', 'reply-a2'])
    expect(markStreamReadMock.mock.calls.at(-1)?.[2]).toBe(3)
    expect(latestStore?.chats[0]?.unread_count).toBe(0)
  })
  it('does not bleed the previously open thread rows into the locator thread', async () => {
    serverRows = [
      peerRow(1, { id: ROOT_A, is_thread_root: true }),
      peerRow(2, { id: 'reply-a1', thread_root_id: ROOT_A }),
      peerRow(3, { id: ROOT_B, is_thread_root: true }),
      peerRow(4, { id: 'reply-b1', thread_root_id: ROOT_B }),
    ]
    projection = threadProjection(ROOT_B)
    serverThreadReadSeq.set(threadStreamId(ROOT_B), 3)
    await renderProvider()
    await act(async () => { latestStore?.setActiveChatId(CHAT_ID) })
    await flushReact()
    await act(async () => { latestStore?.openThread(ROOT_A) })
    await flushReact()
    await waitForCondition(() => latestStore?.threadMessages.some((row) => row.id === 'reply-a1') === true, 'thread A never opened')
    await settleLocatorOpen(latestStore!.openUnreadChat(CHAT_ID))
    expect(latestStore?.activeThreadRootId).toBe(ROOT_B)
    expect(latestStore?.threadMessages.map((row) => row.id)).toEqual([ROOT_B, 'reply-b1'])
    expect(markStreamReadMock.mock.calls.at(-1)?.[2]).toBe(4)
  })
})
