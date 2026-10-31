// @vitest-environment jsdom
//
// @@@5856 话题这一面的三条**看不见但会坏**的接线 —— product spec。
// 这三条都属于「不写判据就永远没人发现」的那类:界面上不会报错,只是某件事一直不发生。
//   ① 分栏里读过的消息要推已读水位。不推 ⇒ 那条话题在会话列表里永远挂着未读,
//      而「通知只到参与者」的另一半正是「读过了就别再叫我」。
//   ② 别人在我正看的这条线上开了话题 ⇒ 当场重拉清单(服务端给来源线成员发 chat_changed,
//      迁移 20260918223500)。老的 thread 面板有这条实时(#1588),换成话题不能反而丢掉。
//      反例同样钉住:别的线上开话题 ❌ 不许触发重拉(那是白跑一次往返)。
//   ③ 分栏里 @ 到的人要真的写进 to_user_ids —— 那是「被 @ 进来」的唯一通路。
import { chatWindowStub, topicHistoryStub } from '../../support/chatWindowStub'
import { renderWithConversations } from '../../support/conversationAccountStub'
import { act, createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, chat, message, renderWithAppProviders } from '../../support/testHarness'

const listTopicsOfChat = vi.fn<(sourceChatId: string) => Promise<TopicSummary[]>>()
const getMessages = vi.fn<() => Promise<MessageItem[]>>()
const markRead = vi.hoisted(() => vi.fn<(chatId: string, seq: number) => Promise<unknown>>())
const sendScopedMessage = vi.fn()
const actionsOf = vi.fn((id: string | null) => ({ ...topicHistoryStub(id ?? ''), sendMessage: sendScopedMessage }))
function sendingFixture() { const fixture = chatWindowStub(); fixture.conversations.actions = actionsOf; return fixture }
const onCreateFailed = vi.fn()
const createTopic = vi.fn()
let sourceMessages: MessageItem[]

vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: (sourceChatId: string) => listTopicsOfChat(sourceChatId),
    createTopic: (...args: unknown[]) => createTopic(...args),
  },
}))
// 云端主线读位经唯一写入口 writeRead;这里按 (chatId, seq) 记下它。
vi.mock('../../../apps/desktop/src/lib/readWriter', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/lib/readWriter')>(),
  writeRead: async (target: { kind: string; chatId?: string; seq?: number }) => (target.kind === 'main' ? markRead(target.chatId!, target.seq!) : undefined),
}))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: (...args: unknown[]) => getMessages(...(args as [])),
    _callCountsBySource: {},
    getOtherMembersReadSeqs: () => Promise.resolve({}),
    revalidateWindow: (ids: string[]) => Promise.resolve({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }),
  },
}))

vi.mock('../../../apps/desktop/src/lib/chatMessageWriter', () => ({
  writeIdempotentChatMessage: () => { throw new Error('topic bypassed shared send queue') },
}))

const { useTopicSurface } = await import('../../../apps/desktop/src/hooks/useTopicSurface')
// The topic open beside a group is its tab (chat-tabs), kept for the window: each case starts with none.
const { closeTopicTab, openPanelItem, closeChatTab } = await import('../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts')
type Surface = ReturnType<typeof useTopicSurface>

function topic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    chat_id: 'topic-1', name: '分片下载失败', source_message_id: 'msg-1', creator_user_id: 'user-1',
    last_message_at: '2026-09-18T00:00:00.000Z', message_count: 1, participant_count: 1,
    is_participant: true, ...overrides,
  }
}

type RevisionListener = (operations: readonly { revision: string; event: string; payload: unknown }[]) => void | Promise<void>
let listeners: Map<string, Set<RevisionListener>>
const subscribeAccountRevision = (event: string, listener: RevisionListener) => {
  let bucket = listeners.get(event)
  if (!bucket) { bucket = new Set(); listeners.set(event, bucket) }
  bucket.add(listener)
  return () => { bucket.delete(listener) }
}
/** 载荷与 sync_since 同形(resource_key + tombstone);extra 补各事件自己的键。 */
async function emit(event: string, chatId: string, extra: Record<string, unknown> = {}) {
  await act(async () => {
    for (const listener of listeners.get(event) ?? []) await listener([{ revision: '1', event, payload: { chat_id: chatId, tombstone: false, ...extra } }])
    await Promise.resolve()
  })
}

let harness: ReturnType<typeof createReactHarness>
let surface: Surface | null
function Probe({ chatKind = 'group' }: { chatKind?: 'group' | 'topic' }) {
  surface = useTopicSurface({
    messages: sourceMessages,
    chat: { id: 'chat-A', kind: chatKind },
    userId: 'user-1',
    closeRightSurfaces: () => {},
    subscribeAccountRevision,
    onCreateFailed,
    embedded: true,
  })
  return null
}
// 打开分栏这一步本身要在 act 里做,否则 setState 的警告会淹掉真实断言。
function OpenSplit({ chatId, name }: { chatId: string; name: string }) {
  const target = surface
  useEffect(() => { target?.openSplit({ chatId, name }) }, [target, chatId, name])
  return null
}

beforeEach(() => {
  listeners = new Map()
  sourceMessages = []
  createTopic.mockReset().mockResolvedValue({ chat_id: 'topic-1', name: 'Projected default' })
  surface = null
  listTopicsOfChat.mockReset().mockResolvedValue([topic()])
  getMessages.mockReset().mockResolvedValue([])
  markRead.mockReset().mockResolvedValue(undefined)
  actionsOf.mockClear()
  sendScopedMessage.mockReset().mockResolvedValue('client-id')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  closeTopicTab('chat-A')
})

async function mount() {
  await renderWithAppProviders(harness, createNode(Probe, {}), { chat: sendingFixture() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function openSplit(real = false) {
  if (real) await renderWithConversations(harness, createElement('div', null, createNode(Probe, {}), createNode(OpenSplit, { chatId: 'topic-1', name: '分片下载失败' })), subscribeAccountRevision, { chat: { chats: [chat({ id: 'topic-1', unread_count: 9 })] } })
  else await renderWithAppProviders(harness, createElement('div', null, createNode(Probe, {}), createNode(OpenSplit, { chatId: 'topic-1', name: '分片下载失败' })), { chat: sendingFixture() })
  await act(async () => { await vi.dynamicImportSettled() })
}

describe('topic reading uses the shared visible-message watermark', () => {
  it('loading a window does not mark hidden rows read; the actually visible row advances the watermark', async () => {
    getMessages.mockResolvedValue([message({ id: 'm1', chat_id: 'topic-1', seq: 3 }), message({ id: 'm2', chat_id: 'topic-1', seq: 7 })])
    await openSplit(true)
    expect(markRead).not.toHaveBeenCalled()
    await act(async () => { surface?.splitLine.markMessageVisible(surface.splitLine.messages[0]!) })
    expect(markRead).toHaveBeenLastCalledWith('topic-1', 3)
  })
  it('does not mark a newer row until it becomes visible, and does not repeat a settled watermark', async () => {
    getMessages.mockResolvedValue([message({ id: 'm1', chat_id: 'topic-1', seq: 3 })])
    await openSplit(true)
    await act(async () => { surface?.splitLine.markMessageVisible(surface.splitLine.messages[0]!) })
    expect(markRead).toHaveBeenCalledTimes(1)
    await act(async () => { surface?.splitLine.markMessageVisible(surface.splitLine.messages[0]!) })
    expect(markRead).toHaveBeenCalledTimes(1)
    getMessages.mockResolvedValue([message({ id: 'm2', chat_id: 'topic-1', seq: 9 })])
    await emit('message_created', 'topic-1', { entity_id: 'm2' })
    expect(markRead).toHaveBeenCalledTimes(1)
    await act(async () => { surface?.splitLine.markMessageVisible(surface.splitLine.messages.find((row) => row.id === 'm2')!) })
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenLastCalledWith('topic-1', 9)
  })
  it('does not advance an empty conversation', async () => {
    await openSplit(true)
    expect(markRead).not.toHaveBeenCalled()
  })
})

describe('别人在这条线上开了话题,清单当场重拉', () => {
  it('来源线的 chat_changed 触发重拉', async () => {
    await mount()
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await emit('chat_changed', 'chat-A')
    expect(listTopicsOfChat).toHaveBeenCalledTimes(2)
  })

  it('反例:别的线上的 chat_changed ❌ 不许重拉(否则上一条判据是死的)', async () => {
    await mount()
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await emit('chat_changed', 'some-other-chat')
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
  })
})

describe('#6010 摘要参与人数随来源线的失效通知更新', () => {
  it('非参与者也重读人数；加入、退出不依赖话题新消息，其他来源线不影响它', async () => {
    listTopicsOfChat.mockResolvedValue([topic({ participant_count: 1, is_participant: false })])
    await mount()
    expect(surface?.anchorsByMessageId.get('msg-1')?.[0]?.participant_count).toBe(1)
    for (const count of [2, 1]) {
      listTopicsOfChat.mockResolvedValue([topic({ participant_count: count, is_participant: false })])
      await emit('chat_changed', 'chat-A')
      expect(surface?.anchorsByMessageId.get('msg-1')?.[0]?.participant_count).toBe(count)
      expect(surface?.topics[0]?.is_participant).toBe(false)
    }
    expect(listTopicsOfChat).toHaveBeenCalledTimes(3)
    await emit('chat_changed', 'chat-B')
    expect(listTopicsOfChat).toHaveBeenCalledTimes(3)
    expect(getMessages).not.toHaveBeenCalled()
  })
})

describe('分栏里 @ 到的人写进 to_user_ids', () => {
  it('keeps the open topic history when its tab is hidden, and releases it when closed', async () => {
    await openSplit()
    const history = surface!.splitLine.messageWindow
    actionsOf.mockClear()
    const board = await act(async () => openPanelItem('chat-A', { kind: 'kanban.board', title: 'Board' }))
    expect(surface!.splitTopic).toBeNull()
    expect(surface!.topic?.chatId).toBe('topic-1')
    expect(surface!.splitLine.messageWindow).toBe(history)
    expect(actionsOf).not.toHaveBeenCalled()
    await act(async () => closeTopicTab('chat-A'))
    expect(surface!.topic).toBeNull()
    expect(actionsOf).toHaveBeenLastCalledWith(null, expect.any(Object))
    await act(async () => closeChatTab('chat-A', board!))
  })

  it('#6004: @所有人 keeps the topic chat ID and broadcast sentinel, without expanding source members', async () => {
    await openSplit()
    await act(async () => { await surface?.sendInSplit('@所有人 看一下', ['*']) })
    expect(actionsOf).toHaveBeenLastCalledWith('topic-1', expect.any(Object))
    expect(sendScopedMessage).toHaveBeenLastCalledWith('@所有人 看一下', { toUserIds: ['*'], replyToMessageId: null })
  })

  it('keeps explicit recipients and replies on the shared optimistic outbox path', async () => {
    await openSplit()
    await act(async () => { await surface?.sendInSplit('小柯 看一下', ['agent-9'], 'original-message') })
    expect(sendScopedMessage).toHaveBeenLastCalledWith('小柯 看一下', { toUserIds: ['agent-9'], replyToMessageId: 'original-message' })
    await act(async () => { await surface?.sendInSplit('我先看看', []) })
    expect(sendScopedMessage).toHaveBeenLastCalledWith('我先看看', { toUserIds: null, replyToMessageId: null })
    await act(async () => { await surface?.sendInSplit('timed', [], null, false, 123) })
    expect(sendScopedMessage).toHaveBeenLastCalledWith('timed', { toUserIds: null, replyToMessageId: null, isWhisper: false, submittedAt: 123 })
  })

  it('does not send an empty or closed topic and preserves shared queue failures', async () => {
    await mount()
    await surface?.sendInSplit('not open')
    expect(sendScopedMessage).not.toHaveBeenCalled()
    await openSplit()
    await surface?.sendInSplit('   ')
    expect(sendScopedMessage).not.toHaveBeenCalled()
    sendScopedMessage.mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(surface?.sendInSplit('keep my draft')).rejects.toThrow('queue unavailable')
  })
})

it('projects agent references before naming a topic and still recognizes the supplied name as automatic', async () => {
  const { isTopicNameCutFromSource } = await import('../../../apps/desktop/src/components/chat/topicAnchorModels')
  const source = message({ id: 'ref-source', content_type: 'text', content: '@[Claude 17](aid:11111111-1111-4111-8111-111111111111) Reply with a task reference and enough text to exceed the title limit.\nSecond line' })
  sourceMessages = [source]
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  const input = createTopic.mock.calls[0]?.[0]
  expect(input).toMatchObject({ sourceChatId: 'chat-A', sourceMessageId: source.id, name: '@Claude 17 Reply with a task reference a…' })
  expect(isTopicNameCutFromSource(input.name, source.content)).toBe(true)
})

it.each(['system', 'attachment'] as const)('keeps server naming for a %s source', async (content_type) => {
  const source = message({ id: 'non-text-source', content_type, content: 'Non-text payload' })
  sourceMessages = [source]
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  expect(createTopic).toHaveBeenCalledWith({ sourceChatId: 'chat-A', sourceMessageId: source.id, name: null })
})

it('opens the existing task topic when its card is tapped again without making a second entry', async () => {
  const source = message({ id: 'task-card', content_type: 'card', content: JSON.stringify({
    v: 1, type: 'task', text: 'Check the project', agentUserId: 'agent', agentName: 'Claude',
    sessionId: 'session', projectId: 'project', deviceId: 'mac', machineLabel: 'Mac',
  }) })
  sourceMessages = [source]
  listTopicsOfChat.mockResolvedValue([topic({ source_message_id: source.id })])
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  expect(createTopic).not.toHaveBeenCalled()
  expect(surface?.splitTopic).toEqual({ chatId: 'topic-1', name: '分片下载失败' })
})
