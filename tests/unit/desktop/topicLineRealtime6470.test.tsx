// @vitest-environment jsdom
//
// @@@6470 话题分栏这条线的实时,与主区 activeChat 走同一份 subscribeChatLineRevisions。
// 报障形态(owner 2026-09-25):在话题里 @ 一个 agent,它读了,我这条的已读状态不动,刷新 / 退出再进才有。
// 两个缺口各钉一条,再钉「话题线收得到全部线级事件」与反例(别的 chat 的事件不动这条线):
//   ① agent 的已读只经 delivery_changed 到达(mark_read_on_deliver 必写逐条读行;水位前面有别人的未读就不动);
//   ② 被 @ 就是被拉进话题 ⇒ 开分栏时拉的水位表里没有它 ⇒ 收件方 = to_user_ids ∩ 表 = 空,读行到了也不出环。
import { act, createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { deriveMessageSendState, deriveReadReceipt } from '@gugu/core/shared/ui/messageState'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../support/testHarness'

const getMessages = vi.fn<(...args: unknown[]) => Promise<MessageItem[]>>()
const getOtherMembersReadSeqs = vi.fn<(chatId: string, userId: string) => Promise<Record<string, number>>>()
const fetchMessageOverlays = vi.fn<(ids: string[], userId: string) => Promise<Map<string, { reactions: unknown[] }>>>()
const revalidateWindow = vi.fn<(ids: string[], userId: string) => Promise<unknown>>()

vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: () => Promise.resolve([topic()]),
    createTopic: vi.fn(),
  },
}))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: (...args: unknown[]) => getMessages(...args),
    getOtherMembersReadSeqs: (chatId: string, userId: string) => getOtherMembersReadSeqs(chatId, userId),
    fetchMessageOverlays: (ids: string[], userId: string) => fetchMessageOverlays(ids, userId),
    revalidateWindow: (ids: string[], userId: string) => revalidateWindow(ids, userId),
    markRead: () => Promise.resolve(),
  },
}))

const { useTopicSurface } = await import('../../../apps/desktop/src/hooks/useTopicSurface')
type Surface = ReturnType<typeof useTopicSurface>

function topic(): TopicSummary {
  return {
    chat_id: 'topic-1', name: '分片下载失败', source_message_id: 'msg-src', creator_user_id: 'user-1',
    last_message_at: '2026-09-25T00:00:00.000Z', message_count: 1, participant_count: 1, is_participant: true,
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
/** 载荷与 sync_since 同形:resource_key(chat_id / entity_id|user_id / 各事件的值)并上 tombstone。 */
async function emit(event: string, payload: Record<string, unknown>) {
  await act(async () => {
    for (const listener of listeners.get(event) ?? []) await listener([{ revision: '1', event, payload: { tombstone: false, ...payload } }])
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

let harness: ReturnType<typeof createReactHarness>
let surface: Surface | null
function Probe() {
  surface = useTopicSurface({
    chat: { id: 'chat-A', kind: 'group' },
    userId: 'user-1',
    closeRightSurfaces: () => {},
    subscribeAccountRevision,
    onCreateFailed: () => {},
  })
  return null
}
function OpenSplit() {
  const target = surface
  useEffect(() => { target?.openSplit({ chatId: 'topic-1', name: '分片下载失败' }) }, [target])
  return null
}
async function openSplit() {
  await renderWithAppProviders(harness, createElement('div', null, createNode(Probe, {}), createNode(OpenSplit, {})))
  await act(async () => { await vi.dynamicImportSettled() })
}

/** 我在话题里 @ agent-9 的那一条(发送方视角 is_mine)。 */
const mention = message({ id: 'mine', chat_id: 'topic-1', sender_user_id: 'user-1', to_user_ids: ['agent-9'], seq: 5, is_mine: true })

function receiptOf(id: string) {
  const row = surface?.splitMessages.find((item) => item.id === id)
  if (!row) throw new Error(`message ${id} is not in the topic line`)
  const seqs = surface!.splitMemberReadSeqs
  const messageReaders = row.readers?.length ? { [row.id]: new Set(row.readers) } : {}
  return {
    receipt: deriveReadReceipt(row, seqs, { messageReaders }),
    state: deriveMessageSendState(row, seqs, { memberIds: Object.keys(seqs), messageReaders }),
  }
}

beforeEach(() => {
  listeners = new Map()
  surface = null
  getMessages.mockReset().mockResolvedValue([mention])
  getOtherMembersReadSeqs.mockReset().mockResolvedValue({})
  fetchMessageOverlays.mockReset().mockResolvedValue(new Map())
  revalidateWindow.mockReset().mockImplementation(async (ids) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }))
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('#6470 话题里 @ agent,它读了 ⇒ 不刷新、不重进,已读当场翻', () => {
  it('被 @ 进来的 agent 进分母,它的逐条读行到达后环翻成 1/1、发送态翻成已读', async () => {
    await openSplit()
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['mine'])
    // 开分栏时 agent 还不是这条话题的成员:分母里没有它
    expect(receiptOf('mine').receipt.totalRecipients).toBe(0)

    // ② 这条消息把 agent-9 拉进了话题(join_topic_participants 的 INSERT ⇒ chat_members_changed)
    getOtherMembersReadSeqs.mockResolvedValueOnce({ 'agent-9': 0 })
    await emit('chat_members_changed', { chat_id: 'topic-1', user_id: 'agent-9' })
    expect(getOtherMembersReadSeqs).toHaveBeenLastCalledWith('topic-1', 'user-1')
    expect(receiptOf('mine').receipt).toMatchObject({ readCount: 0, totalRecipients: 1 })

    // ① agent 读了:水位被前面别人的未读卡住,只有逐条读行 ⇒ delivery_changed
    const fetchesBefore = getMessages.mock.calls.length
    const revalidationsBefore = revalidateWindow.mock.calls.length
    await emit('delivery_changed', { chat_id: 'topic-1', entity_id: 'mine', device_id: 'gugu-agent:agent-9', status: 'read' })
    expect(receiptOf('mine').receipt).toMatchObject({ readCount: 1, totalRecipients: 1, readerIds: ['agent-9'] })
    expect(receiptOf('mine').state).toBe('read')
    // 回执直接打在行上:❌ 不为一条回执重拉整页
    expect(getMessages.mock.calls.length).toBe(fetchesBefore)
    expect(revalidateWindow).toHaveBeenCalledTimes(revalidationsBefore)
  })

  it('水位推进(member_read_changed)同样当场生效', async () => {
    getOtherMembersReadSeqs.mockResolvedValue({ 'agent-9': 0 })
    await openSplit()
    expect(receiptOf('mine').receipt.readCount).toBe(0)
    await emit('member_read_changed', { chat_id: 'topic-1', entity_id: 'agent-9', last_read_seq: 5 })
    expect(receiptOf('mine').receipt.readCount).toBe(1)
  })

  it('反例:来源群(chat-A)与别的 chat 的回执/成员变动 ❌ 不动话题这条线', async () => {
    await openSplit()
    getOtherMembersReadSeqs.mockClear()
    await emit('delivery_changed', { chat_id: 'chat-A', entity_id: 'mine', device_id: 'gugu-agent:agent-9', status: 'read' })
    await emit('chat_members_changed', { chat_id: 'chat-A', user_id: 'agent-9' })
    expect(surface?.splitMessages[0]?.readers ?? []).toEqual([])
    expect(getOtherMembersReadSeqs).not.toHaveBeenCalled()
    expect(receiptOf('mine').receipt.totalRecipients).toBe(0)
  })
})

describe('#6470 成员变动只在分母真变了时才回读', () => {
  it('已在表里的人的行更新 ❌ 不回读;退出的人从分母里摘掉', async () => {
    getOtherMembersReadSeqs.mockResolvedValue({ 'agent-9': 0, 'user-2': 5 })
    await openSplit()
    await act(async () => { await Promise.resolve() })
    getOtherMembersReadSeqs.mockClear()

    // chat_members 的每一次读水位 UPDATE 都会发这条 —— 为它回读就是把 #5649 省掉的往返又加回来
    await emit('chat_members_changed', { chat_id: 'topic-1', user_id: 'user-2' })
    expect(getOtherMembersReadSeqs).not.toHaveBeenCalled()

    await emit('chat_members_changed', { chat_id: 'topic-1', user_id: 'user-2', tombstone: true })
    expect(surface?.splitMemberReadSeqs).toEqual({ 'agent-9': 0 })
    expect(getOtherMembersReadSeqs).not.toHaveBeenCalled()
  })
})

describe('#6470 话题线收得到全部线级事件(与主线同一份订阅)', () => {
  it('挂上的线级事件与主线一致,另加来源线的 chat_changed(话题清单)', async () => {
    await openSplit()
    const claimed = [...listeners.entries()].filter(([, bucket]) => bucket.size > 0).map(([event]) => event).sort()
    expect(claimed).toEqual([
      'chat_changed', 'chat_members_changed', 'delivery_changed', 'member_read_changed',
      'message_created', 'message_deleted', 'reaction_changed',
    ])
  })

  it('别人的表情与删除当场落在分栏里', async () => {
    getMessages.mockResolvedValue([mention, message({ id: 'peer', chat_id: 'topic-1', sender_user_id: 'agent-9', seq: 6 })])
    await openSplit()
    fetchMessageOverlays.mockResolvedValueOnce(new Map([['mine', { reactions: [{ emoji: '👍', count: 1, my_reaction: false }] }]]))
    await emit('reaction_changed', { chat_id: 'topic-1', entity_id: 'mine' })
    expect(surface?.splitMessages.find((row) => row.id === 'mine')?.reactions).toEqual([{ emoji: '👍', count: 1, my_reaction: false }])

    await emit('message_deleted', { chat_id: 'topic-1', entity_id: 'peer', tombstone: true })
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['mine'])
  })

  it('带消息本体的新消息直接落窗口,❌ 不再整页替换(往上翻出来的旧页不许被冲掉)', async () => {
    await openSplit()
    getMessages.mockResolvedValueOnce([message({ id: 'old', chat_id: 'topic-1', seq: 4 })])
    await act(async () => { await surface?.revealOlderInSplit() })
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['old', 'mine'])
    const fetchesBefore = getMessages.mock.calls.length

    await emit('message_created', { chat_id: 'topic-1', entity_id: 'reply', message: {
      id: 'reply', chat_id: 'topic-1', sender_user_id: 'agent-9', seq: 6, content: '收到', content_type: 'text', created_at: '2026-09-25T00:00:06Z',
    } })
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['old', 'mine', 'reply'])
    expect(getMessages.mock.calls.length).toBe(fetchesBefore)
  })

  it('首页在途时到达的新消息不许被首页冲掉(打开话题、agent 当场回一句)', async () => {
    let resolvePage: (rows: MessageItem[]) => void = () => {}
    getMessages.mockImplementationOnce(() => new Promise<MessageItem[]>((resolve) => { resolvePage = resolve }))
    await openSplit()
    await emit('message_created', { chat_id: 'topic-1', entity_id: 'reply', message: {
      id: 'reply', chat_id: 'topic-1', sender_user_id: 'agent-9', seq: 6, content: '收到', content_type: 'text', created_at: '2026-09-25T00:00:06Z',
    } })
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['reply'])
    await act(async () => {
      resolvePage([mention])
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    expect(surface?.splitMessages.map((row) => row.id)).toEqual(['mine', 'reply'])
  })
})
