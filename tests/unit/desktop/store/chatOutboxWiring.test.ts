// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import {
  createOutboxWiring,
  resolveOutboxRecipients,
  type OutboxWiringIo,
} from '../../../../apps/desktop/src/store/chatOutboxWiring'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

function persistedMessage(id: string): MessageItem {
  return {
    id,
    chat_id: 'chat-1',
    sender_user_id: 'owner-1',
    to_user_ids: null,
    is_whisper: false,
    seq: 42,
    content: 'hello',
    content_type: 'text',
    reply_to_message_id: null,
    thread_root_id: null,
    is_thread_root: false,
    retracted_at: null,
    created_at: '2026-07-27T00:00:00.000Z',
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: null,
  }
}

function optimisticMessage(id: string): MessageItem {
  return {
    ...persistedMessage(id),
    seq: -1,
    local_send_state: 'sending',
  }
}

function wiringHarness(messageId: string) {
  let messages = [optimisticMessage(messageId)]
  let threadMessages: MessageItem[] = []
  const toast = vi.fn<OutboxWiringIo['toast']>()
  const patchChat = vi.fn<OutboxWiringIo['patchChat']>()
  // @@@4439 — store 摄入 chokepoint 的替身:按 id 归并进主线(跳号重验证语义属 store 侧,
  // 由 chatMessageWindow 的 seqJumpRepairCursor 纯函数测试钉住)。
  const appendMessage = vi.fn<OutboxWiringIo['appendMessage']>((message) => {
    messages = upsertMessageById(messages, message)
  })
  const repository = openImRepository('owner-1', {
    adapter: createMemoryLocalSyncDb(),
    storage: window.localStorage,
  })
  const io: OutboxWiringIo = {
    getImRepository: () => repository,
    user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
    identity: () => undefined,
    chats: () => [],
    activeChatId: () => 'chat-1',
    activeThreadRootId: () => null,
    setMessagesAndCache: (updater) => { messages = updater(messages) },
    setThreadMessages: (updater) => {
      threadMessages = typeof updater === 'function' ? updater(threadMessages) : updater
    },
    patchChat,
    toast,
    appendMessage,
  }
  return {
    wiring: createOutboxWiring(io),
    messages: () => messages,
    patchChat,
    toast,
    appendMessage,
  }
}

function enqueueInput(id: string) {
  return {
    id,
    chatId: 'chat-1',
    senderUserId: 'owner-1',
    content: 'hello',
    toUserIds: ['agent-1'],
    replyToMessageId: null,
    threadRootId: null,
    isThreadRoot: false,
    isWhisper: false,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('committed outbound reconciliation', () => {
  it('stale restoreAndWatch after dispose never reacquires the repository', async () => {
    const getImRepository = vi.fn(async () => openImRepository('owner-1', {
      adapter: createMemoryLocalSyncDb(), storage: window.localStorage,
    }))
    const io: OutboxWiringIo = {
      getImRepository,
      user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
      identity: () => undefined,
      chats: () => [], activeChatId: () => null, activeThreadRootId: () => null,
      setMessagesAndCache: () => {}, setThreadMessages: () => {}, patchChat: () => {},
      toast: () => {},
      appendMessage: () => {},
    }
    const wiring = createOutboxWiring(io)

    wiring.dispose()
    const stop = wiring.restoreAndWatch()
    await flushMicrotasks()
    stop()

    expect(getImRepository).not.toHaveBeenCalled()
  })

  it('rejects if dispose wins before repository acquisition instead of acknowledging an absent row', async () => {
    const repositoryReady = deferred<AccountImRepository>()
    const repository = await openImRepository('owner-1', {
      adapter: createMemoryLocalSyncDb(), storage: window.localStorage,
    })
    const io: OutboxWiringIo = {
      getImRepository: () => repositoryReady.promise,
      user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
      identity: () => undefined,
      chats: () => [], activeChatId: () => null, activeThreadRootId: () => null,
      setMessagesAndCache: () => {}, setThreadMessages: () => {}, patchChat: () => {},
      toast: () => {},
      appendMessage: () => {},
    }
    const wiring = createOutboxWiring(io)
    const enqueue = wiring.enqueue(enqueueInput('11111111-1111-4111-8111-111111111111'))

    wiring.dispose()
    repositoryReady.resolve(repository)

    await expect(enqueue).rejects.toThrow(/disposed before durable enqueue/i)
    expect(repository.snapshot().outbox).toEqual([])
  })

  it('commits the RPC row directly without a getMessageById round trip', async () => {
    const row = persistedMessage('message-4')
    vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    vi.spyOn(chatService, 'getMessageById')
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue(enqueueInput(row.id))
    await flushMicrotasks()

    await vi.waitFor(() => {
      expect(harness.messages()[0]).toMatchObject({ id: row.id, seq: 42, local_send_state: null })
    })
    expect(chatService.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatService.getMessageById).not.toHaveBeenCalled()
    expect(harness.messages()).toHaveLength(1)
    expect(harness.toast).not.toHaveBeenCalled()
  })

  // @@@4439 — 权威 row 必须经 store 的单行摄入 chokepoint(appendMessage)落窗,那里承载跳号重验证;
  // 若 wiring 绕开它直接 setMessagesAndCache,交错落库的入站行会沉到增量游标下方、三路取数全部漏掉。
  it('routes the authoritative ack row through the store ingestion chokepoint (#4439)', async () => {
    const row = persistedMessage('message-5') // 权威 seq=42
    vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue(enqueueInput(row.id))
    await vi.waitFor(() => {
      expect(harness.appendMessage).toHaveBeenCalledWith(row)
    })
    expect(harness.appendMessage).toHaveBeenCalledTimes(1)
    // #1884 — 水位推进不等重验证:appendMessage(同步返回)之后同一 tick 就推进。
    await vi.waitFor(() => {
      expect(harness.messages().find((m) => m.id === row.id)).toMatchObject({ seq: 42 })
    })
  })
})

describe('投递前置:乐观行先上屏,就绪/对端解析在投递阶段 (C1/C2)', () => {
  it('C2 私聊对端未就绪:enqueue 不等对端解析,投递时解析并按对端投递', async () => {
    const row = persistedMessage('message-c2')
    const peer = deferred<string | null>()
    vi.spyOn(chatService, 'getDmPeerUserId').mockReturnValue(peer.promise)
    const send = vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue({ ...enqueueInput(row.id), toUserIds: null, resolveDmPeer: true })
    // enqueue 已返回、乐观行在屏上「发送中」,对端解析还在路上,没有投出去
    expect(harness.messages()[0]).toMatchObject({ id: row.id, local_send_state: 'sending' })
    await vi.waitFor(() => expect(chatService.getDmPeerUserId).toHaveBeenCalledWith('chat-1', 'owner-1'))
    expect(send).not.toHaveBeenCalled()

    peer.resolve('agent-9')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]![5]).toMatchObject({ toUserIds: ['agent-9'] })
    await vi.waitFor(() => expect(harness.messages()[0]).toMatchObject({ seq: 42, local_send_state: null }))
  })

  it('C2 对端解析不到 → 气泡变「未送达」,消息从未以 null 收件人投出', async () => {
    vi.useFakeTimers()
    vi.spyOn(chatService, 'getDmPeerUserId').mockResolvedValue(null)
    const send = vi.spyOn(chatService, 'sendMessage')
    const harness = wiringHarness('message-c2-missing')

    await harness.wiring.enqueue({ ...enqueueInput('message-c2-missing'), toUserIds: null, resolveDmPeer: true })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(send).not.toHaveBeenCalled()
    expect(harness.messages()[0]).toMatchObject({ id: 'message-c2-missing', local_send_state: 'failed' })
  })

  it('C1 投递前置在投递前跑、不挡乐观行;前置失败 → 未送达,手动重试再跑一次前置', async () => {
    vi.useFakeTimers()
    const row = persistedMessage('message-c1')
    const send = vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    let ready = false
    const beforeDeliver = vi.fn(async () => { if (!ready) throw new Error('session not ready') })
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue({ ...enqueueInput(row.id), beforeDeliver })
    expect(harness.messages()[0]).toMatchObject({ id: row.id, local_send_state: 'sending' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(beforeDeliver).toHaveBeenCalledTimes(3) // 3 次尝试,每次先过前置
    expect(send).not.toHaveBeenCalled()
    expect(harness.messages()[0]).toMatchObject({ local_send_state: 'failed' })

    ready = true
    harness.wiring.retrySend(row.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(beforeDeliver).toHaveBeenCalledTimes(4)
    expect(send).toHaveBeenCalledTimes(1)
    expect(harness.messages()[0]).toMatchObject({ seq: 42, local_send_state: null })
  })
})

describe('resolveOutboxRecipients (C2)', () => {
  const base = {
    clientMessageId: 'm', chatId: 'chat-1', senderUserId: 'owner-1', state: 'pending', attempts: 0, lastError: null,
    enqueuedAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    payload: { content: 'x', contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
  } satisfies OutboxRecord
  it('不需要解析的记录原样返回(同一引用 ⇒ outbox 不重复落盘)', async () => {
    const lookup = vi.fn()
    expect(await resolveOutboxRecipients(base, lookup)).toBe(base)
    const explicit = { ...base, payload: { ...base.payload, toUserIds: ['a'], resolveDmPeer: true } }
    expect(await resolveOutboxRecipients(explicit, lookup)).toBe(explicit)
    expect(lookup).not.toHaveBeenCalled()
  })
  it('解析成功写回 toUserIds 并清掉标记;查询失败原样抛出(不吞成「收件人不可用」)', async () => {
    const pending = { ...base, payload: { ...base.payload, resolveDmPeer: true } }
    const resolved = await resolveOutboxRecipients(pending, async () => 'peer-1')
    expect(resolved.payload).toMatchObject({ toUserIds: ['peer-1'], resolveDmPeer: false })
    await expect(resolveOutboxRecipients(pending, async () => { throw new Error('network down') })).rejects.toThrow('network down')
  })
})
