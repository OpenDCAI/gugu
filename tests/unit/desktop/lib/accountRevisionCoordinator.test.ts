import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository as openRawRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator, PRESENCE_TRAILING_DRAIN_MS, readDeliveryRevision, readMemberReadRevision, readMemberRosterRevision, readMessageCreatedRevision, readRevisionResourceKey, readWorkspaceChanges } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionPage, AccountRevisionSource } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { entityKey, membershipId, operationKeys } from '../../../../apps/desktop/src/lib/chatProjectionAlgebra'

async function openImRepository(...args: Parameters<typeof openRawRepository>) {
  const repository = await openRawRepository(...args)
  if (!repository.snapshot().sync_state.some((row) => row.key === 'account-revision-cursor')) {
    await repository.transaction((transaction) => transaction.putSyncState('account-revision-cursor', { revision: '0' }))
  }
  return repository
}

function page(revision: string, event = 'chat_changed'): AccountRevisionPage {
  return { operations: [{ revision, event, payload: { chat_id: 'chat-1' } }], hasMore: false }
}

describe('AccountRevisionCoordinator', () => {
  let syncSince: ReturnType<typeof vi.fn<AccountRevisionSource['syncSince']>>
  let source: AccountRevisionSource
  let wake: ((head?: string | null) => void) | null

  beforeEach(() => {
    syncSince = vi.fn()
    wake = null
    source = {
      syncSince,
      subscribeWake: vi.fn((_accountId: string, listener: (head?: string | null) => void, onSubscribed: () => void) => {
        wake = listener
        onSubscribed()
        return () => undefined
      }),
    }
  })

  afterEach(() => vi.useRealTimers())

  it('keeps a committed operation pending until its consumer succeeds', async () => {
    vi.useFakeTimers()
    const adapter = createMemoryLocalSyncDb()
    const repository = await openImRepository('account-a', { adapter })
    syncSince.mockResolvedValueOnce(page('1')).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const consumer = vi.fn().mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValueOnce(undefined)
    coordinator.subscribe('chat_changed', consumer)

    coordinator.start()
    await expect(coordinator.whenIdle()).rejects.toThrow('refresh failed')
    expect(repository.snapshot().view).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    await coordinator.whenIdle()
    expect(consumer).toHaveBeenCalledTimes(2)
    expect(repository.snapshot().view).toEqual([])
    coordinator.stop()
  })

  it('drains a durable trailing presence revision after the suppression window', async () => {
    vi.useFakeTimers()
    expect(PRESENCE_TRAILING_DRAIN_MS).toBe(2100)
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page('1', 'presence_changed'))
      .mockResolvedValueOnce({ operations: [], hasMore: false })
      .mockResolvedValueOnce({ operations: [{ revision: '2', event: 'presence_changed', payload: { agent_user_id: 'agent-2' } }], hasMore: false })
      .mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const presence = vi.fn()
    coordinator.subscribe('presence_changed', presence)

    coordinator.start()
    await coordinator.whenIdle()
    expect(syncSince).toHaveBeenCalledTimes(2)
    expect(presence).toHaveBeenCalledTimes(1)

    // A second presence mutation can be durable while the server suppresses its
    // wake. The client must not poll early, but must pick it up at the trailing
    // edge even when no later realtime event arrives.
    await vi.advanceTimersByTimeAsync(PRESENCE_TRAILING_DRAIN_MS - 1)
    expect(syncSince).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(PRESENCE_TRAILING_DRAIN_MS)
    await coordinator.whenIdle()

    expect(syncSince).toHaveBeenCalledTimes(3)
    expect(presence).toHaveBeenCalledTimes(2)
    expect(presence.mock.calls[1]![0]).toEqual([{ revision: '2', event: 'presence_changed', payload: { agent_user_id: 'agent-2' } }])
    coordinator.stop()
  })

  it('rechecks a post-window presence wake without waiting for the trailing timer', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page('1', 'presence_changed'))
      .mockResolvedValueOnce({ operations: [], hasMore: false })
      .mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const presence = vi.fn()
    coordinator.subscribe('presence_changed', presence)

    coordinator.start()
    await coordinator.whenIdle()
    expect(wake).not.toBeNull()

    // This wake represents a mutation after the two-second server throttle
    // window. It should drain immediately; the old timer is coalesced away.
    await vi.advanceTimersByTimeAsync(PRESENCE_TRAILING_DRAIN_MS - 50)
    syncSince.mockResolvedValueOnce(page('2', 'presence_changed'))
    expect(presence).toHaveBeenCalledTimes(1)
    wake?.('2')
    await coordinator.whenIdle()

    expect(syncSince).toHaveBeenCalledTimes(3)
    expect(presence).toHaveBeenCalledTimes(2)
    expect(presence.mock.calls[1]![0]).toEqual([expect.objectContaining({ revision: '2' })])
    coordinator.stop()
  })

  it('does not arm a trailing drain for a failed presence settlement, then retries normally', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce(page('1', 'presence_changed')).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const presence = vi.fn()
      .mockRejectedValueOnce(new Error('presence refresh failed'))
      .mockResolvedValue(undefined)
    coordinator.subscribe('presence_changed', presence)

    coordinator.start()
    await expect(coordinator.whenIdle()).rejects.toThrow('presence refresh failed')
    await vi.advanceTimersByTimeAsync(999)
    expect(syncSince).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)
    await coordinator.whenIdle()
    expect(presence).toHaveBeenCalledTimes(2)
    expect(syncSince).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(PRESENCE_TRAILING_DRAIN_MS - 1)
    expect(syncSince).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await coordinator.whenIdle()
    expect(syncSince).toHaveBeenCalledTimes(3)
    coordinator.stop()
  })

  it('cancels a pending trailing drain on stop', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce(page('1', 'presence_changed')).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    coordinator.subscribe('presence_changed', vi.fn())

    coordinator.start()
    await coordinator.whenIdle()
    expect(syncSince).toHaveBeenCalledTimes(2)
    coordinator.stop()
    await vi.advanceTimersByTimeAsync(PRESENCE_TRAILING_DRAIN_MS + 1)

    expect(syncSince).toHaveBeenCalledTimes(2)
  })

  it('replays a persisted inbox marker after restart before deleting it', async () => {
    const adapter = createMemoryLocalSyncDb()
    const firstRepository = await openImRepository('account-a', { adapter })
    syncSince.mockResolvedValueOnce(page('1')).mockResolvedValue({ operations: [], hasMore: false })
    const first = createAccountRevisionCoordinator('account-a', firstRepository, source)
    first.start()
    await first.whenIdle()
    expect(firstRepository.snapshot().view).toHaveLength(1)
    first.stop()
    firstRepository.close()

    const secondRepository = await openImRepository('account-a', { adapter })
    const second = createAccountRevisionCoordinator('account-a', secondRepository, source)
    const consumer = vi.fn()
    second.subscribe('chat_changed', consumer)
    second.start()
    await second.whenIdle()

    expect(consumer).toHaveBeenCalledWith([expect.objectContaining({ revision: '1' })])
    expect(secondRepository.snapshot().view).toEqual([])
    second.stop()
  })

  it('does not overtake an operation whose consumer is not registered yet', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'presence_changed', payload: { agent_user_id: 'agent-1' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const presence = vi.fn()
    coordinator.subscribe('presence_changed', presence)

    coordinator.start()
    await coordinator.whenIdle()
    expect(presence).not.toHaveBeenCalled()
    expect(repository.snapshot().view).toHaveLength(2)

    coordinator.subscribe('chat_changed', vi.fn())
    await coordinator.whenIdle()
    expect(presence).toHaveBeenCalledTimes(1)
    expect(presence).toHaveBeenCalledWith([expect.objectContaining({ revision: '2' })])
    expect(repository.snapshot().view).toEqual([])
    coordinator.stop()
  })

  it('coalesces a ready prefix by event and acknowledges it in one transaction', async () => {
    const delegate = createMemoryLocalSyncDb()
    const commit = vi.fn(delegate.commit)
    const repository = await openImRepository('account-a', { adapter: { ...delegate, commit } })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'presence_changed', payload: { agent_user_id: 'agent-1' } },
        { revision: '3', event: 'chat_changed', payload: { chat_id: 'chat-2' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const chats = vi.fn()
    const presence = vi.fn()
    coordinator.subscribe('chat_changed', chats)
    coordinator.subscribe('presence_changed', presence)

    coordinator.start()
    await coordinator.whenIdle()

    expect(chats).toHaveBeenCalledTimes(1)
    expect(chats).toHaveBeenCalledWith([
      expect.objectContaining({ revision: '1' }),
      expect.objectContaining({ revision: '3' }),
    ])
    expect(presence).toHaveBeenCalledWith([expect.objectContaining({ revision: '2' })])
    expect(commit).toHaveBeenCalledTimes(3) // bootstrap fixture + page + acknowledgement
    expect(repository.snapshot().view).toEqual([])
    coordinator.stop()
  })

  // 这条原先断言的是「后一个 listener 不得在前一个完成前启动」。那条规则已经被合同换掉
  // (revision-dispatch 正文,#5394):它让串行深度按 listener 数累加,正是一条新消息打出 40 环的
  // 一段。防止「较早的 revalidation 覆盖较新的状态」的保护现在属于**归并代数**而不属于调度顺序
  // (chat-projection 的按键版本格 join)⇒ 并行结算是安全的。所以这条判据跟着合同改成:
  // 同一批的 listener **并行**启动,且任一失败仍然不确认该批。
  it('settles same-batch listeners in parallel — depth is per batch, not per listener', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'message-1' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    let releaseChat!: () => void
    let markChatStarted!: () => void
    const chatStarted = new Promise<void>((resolve) => { markChatStarted = resolve })
    const chatSettled = new Promise<void>((resolve) => { releaseChat = resolve })
    const chats = vi.fn(async () => {
      markChatStarted()
      await chatSettled
    })
    const messages = vi.fn()
    coordinator.subscribe('chat_changed', chats)
    coordinator.subscribe('message_created', messages)

    coordinator.start()
    await chatStarted
    // 前一个还卡着,后一个**已经**跑了 —— 这就是「不按 listener 累加深度」的直接读数。
    const laterCallsBeforeRelease = messages.mock.calls.length
    releaseChat()
    await coordinator.whenIdle()
    coordinator.stop()

    expect(laterCallsBeforeRelease, '并行结算:前一个未完成时后一个就该启动').toBe(1)
    expect(messages).toHaveBeenCalledTimes(1)
  })

  // @@@batch-per-consumer(#5394 收口)—— 从前派发按 **event** 分组,于是认领了 k 类 event 的
  // consumer(聊天投影就是)对同一批被叫 k 次。每次都守着自己的「一批一波」上界,合起来却是 k 波
  // (产品面账本实测:一条新消息 4 行推进)。合同说代价不按 event 数累加 ⇒ 一个 consumer 一次调用。
  it('hands a multi-event consumer the whole prefix in ONE call, revision-ordered', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'message-1' } },
        { revision: '3', event: 'presence_changed', payload: { agent_user_id: 'agent-1' } },
        { revision: '4', event: 'member_read_changed', payload: { chat_id: 'chat-1', entity_id: 'user-1' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const projection = vi.fn()
    // 阴性方向的对照:只认领一类 event 的 consumer **不得**因为这次改动收到别人的 operation。
    const presenceOnly = vi.fn()
    coordinator.subscribe(['chat_changed', 'message_created', 'member_read_changed'], projection)
    coordinator.subscribe('presence_changed', presenceOnly)

    coordinator.start()
    await coordinator.whenIdle()
    coordinator.stop()

    expect(projection, '认领 3 类 event ⇒ 一批只被叫一次').toHaveBeenCalledTimes(1)
    expect(projection.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ revision: '1' }),
      expect.objectContaining({ revision: '2' }),
      expect.objectContaining({ revision: '4' }),
    ])
    expect(presenceOnly).toHaveBeenCalledTimes(1)
    expect(presenceOnly.mock.calls[0]![0]).toEqual([expect.objectContaining({ revision: '3' })])
    expect(repository.snapshot().view).toEqual([])
  })

  it('a multi-event registration is the barrier for every event it claims', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'workspace_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'chat_changed', payload: { chat_id: 'chat-1' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const claimed = vi.fn()
    const unsubscribe = coordinator.subscribe(['chat_changed', 'message_created'], claimed)

    coordinator.start()
    await coordinator.whenIdle()
    // 队首 workspace_changed 无人认领 ⇒ barrier,它之后的 chat_changed 不得开始派发。
    expect(claimed, '未认领的队首是 barrier').not.toHaveBeenCalled()
    unsubscribe()
    // 退订必须把它认领的**每一个** event 的认领计数减回去,否则 barrier 会误判成「有人认领」。
    const stillClaimed = vi.fn()
    coordinator.subscribe('workspace_changed', stillClaimed)
    coordinator.retryPending()
    await coordinator.whenIdle()
    coordinator.stop()

    expect(stillClaimed, 'workspace_changed 现在有人认领 ⇒ 它自己可以派发').toHaveBeenCalledTimes(1)
    expect(claimed, '已退订的 registration 不得再被调用').not.toHaveBeenCalled()
  })

  it('R3 一个 listener 失败只卡它自己:同批别的 consumer 照常确认,失败的那个单独退避重试', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce({
      operations: [
        { revision: '1', event: 'device_changed', payload: { chat_id: 'chat-1' } },
        { revision: '2', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'message-1' } },
      ],
      hasMore: false,
    }).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const devices = vi.fn()
      .mockRejectedValueOnce(new Error('device refresh failed'))
      .mockRejectedValueOnce(new Error('device refresh failed again'))
      .mockResolvedValue(undefined)
    const messages = vi.fn()
    coordinator.subscribe('device_changed', devices)
    coordinator.subscribe('message_created', messages)
    const pending = () => repository.snapshot().view
      .filter((row) => row.key.startsWith('account-revision-operation:')).map((row) => row.key)

    coordinator.start()
    await coordinator.whenIdle().catch(() => undefined)
    expect(messages, '新消息不被别的类别的失败挡住').toHaveBeenCalledTimes(1)
    expect(pending(), 'message_created 已确认,只留下失败的 device_changed').toEqual(['account-revision-operation:1'])

    // 新 operation 到来时,退避中的 consumer 不被提前重叫;新消息照常派发
    syncSince.mockResolvedValueOnce({
      operations: [{ revision: '3', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'message-2' } }],
      hasMore: false,
    })
    wake?.('3')
    await coordinator.whenIdle().catch(() => undefined)
    expect(messages).toHaveBeenCalledTimes(2)
    expect(messages.mock.calls[1]![0], '不重放已消费过的').toEqual([expect.objectContaining({ revision: '3' })])
    expect(devices).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    await coordinator.whenIdle().catch(() => undefined)
    expect(devices).toHaveBeenCalledTimes(2)
    expect(pending()).toEqual(['account-revision-operation:1'])
    await vi.advanceTimersByTimeAsync(1999)
    expect(devices, '第二次失败退避 2s').toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await coordinator.whenIdle()
    expect(devices).toHaveBeenCalledTimes(3)
    expect(pending()).toEqual([])
    expect(messages, '失败方重试期间,成功方一次都没被重叫').toHaveBeenCalledTimes(2)
    coordinator.stop()
  })

  it('R3 一个 consumer 失败的那一轮里新到的消息,不等它的退避定时器就派发', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce(page('1', 'device_changed')).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    let failDevices: (error: Error) => void = () => {}
    const devices = vi.fn(() => new Promise<void>((_, reject) => { failDevices = reject }))
    const messages = vi.fn()
    coordinator.subscribe('device_changed', devices)
    coordinator.subscribe('message_created', messages)
    coordinator.start()
    await vi.waitFor(() => expect(devices).toHaveBeenCalledTimes(1))
    // device 结算还在路上时,一条新消息落库
    syncSince.mockResolvedValueOnce({
      operations: [{ revision: '2', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'message-1' } }],
      hasMore: false,
    })
    wake?.('2')
    await vi.waitFor(() => expect(repository.snapshot().view.some((row) => row.key === 'account-revision-operation:2')).toBe(true))
    failDevices(new Error('device refresh failed'))
    await coordinator.whenIdle().catch(() => undefined)
    expect(messages, '没推进任何定时器,新消息已派发').toHaveBeenCalledTimes(1)
    coordinator.stop()
  })
  it('R3 同一 consumer 认领的 operation 仍按序:它失败时后续同类 operation 与它一起重投,不越过', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValueOnce(page('1', 'chat_changed')).mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, source)
    const chats = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(undefined)
    coordinator.subscribe('chat_changed', chats)
    coordinator.start()
    await coordinator.whenIdle().catch(() => undefined)
    syncSince.mockResolvedValueOnce(page('2', 'chat_changed'))
    wake?.('2')
    await coordinator.whenIdle().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1000)
    await coordinator.whenIdle()
    expect(chats).toHaveBeenCalledTimes(2)
    expect(chats.mock.calls[1]![0].map((operation: { revision: string }) => operation.revision)).toEqual(['1', '2'])
    coordinator.stop()
  })
})

describe('membership revision resource keys', () => {
  it('plans the changed membership from the row-trigger payload, including deletion', () => {
    for (const tombstone of [false, true]) {
      const key = readRevisionResourceKey({ chat_id: 'chat-1', user_id: 'user-2', tombstone }, 'chat_members_changed')
      expect(key).toEqual({ chatId: 'chat-1', entityId: 'user-2' })
      expect(operationKeys({ revision: '1', event: 'chat_members_changed', ...key }))
        .toEqual([entityKey('membership', membershipId('chat-1', 'user-2'))])
    }
  })

  it('also reads broadcast entity_id without treating other events user_id as the entity', () => {
    expect(readRevisionResourceKey({ chat_id: 'chat-1', entity_id: 'user-2' }, 'chat_members_changed'))
      .toEqual({ chatId: 'chat-1', entityId: 'user-2' })
    expect(readRevisionResourceKey({ chat_id: 'chat-1', user_id: 'user-2' }, 'message_created'))
      .toEqual({ chatId: 'chat-1', entityId: null })
  })

  it('fails loud on malformed or contradictory member identifiers', () => {
    for (const user_id of [null, '', 7]) {
      expect(() => readRevisionResourceKey({ chat_id: 'chat-1', user_id }, 'chat_members_changed')).toThrow(/user_id/)
    }
    expect(() => readRevisionResourceKey({ chat_id: 'chat-1', user_id: 'user-2', entity_id: '' }, 'chat_members_changed'))
      .toThrow(/entity_id/)
    expect(() => readRevisionResourceKey({ chat_id: 'chat-1', user_id: 'user-2', entity_id: 'user-3' }, 'chat_members_changed'))
      .toThrow(/conflicting/)
  })
})

describe('readMemberRosterRevision (#6470)', () => {
  it('tells a leave (tombstone) apart from a join or row update', () => {
    expect(readMemberRosterRevision({ chat_id: 'topic-1', user_id: 'agent-9', tombstone: false }))
      .toEqual({ chatId: 'topic-1', memberId: 'agent-9', left: false })
    expect(readMemberRosterRevision({ chat_id: 'topic-1', user_id: 'agent-9', tombstone: true }))
      .toEqual({ chatId: 'topic-1', memberId: 'agent-9', left: true })
    expect(readMemberRosterRevision({ chat_id: 'topic-1', tombstone: false }).memberId).toBeNull()
  })

  it('fails loud when sync_since did not stamp a boolean tombstone', () => {
    for (const tombstone of [undefined, null, 'true', 1]) {
      expect(() => readMemberRosterRevision({ chat_id: 'topic-1', user_id: 'agent-9', tombstone })).toThrow(/tombstone/)
    }
  })
})

describe('readMemberReadRevision (#5649)', () => {
  it('reads the reader and the watermark from a post-migration payload', () => {
    expect(readMemberReadRevision({ chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: 7, tombstone: false }))
      .toEqual({ chatId: 'chat-1', userId: 'user-2', lastReadSeq: 7 })
    expect(readMemberReadRevision({ chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: '12' }).lastReadSeq).toBe(12)
  })

  it('reports a null watermark for pre-migration rows so the caller can fetch once', () => {
    expect(readMemberReadRevision({ chat_id: 'chat-1', entity_id: 'user-2', tombstone: false }))
      .toEqual({ chatId: 'chat-1', userId: 'user-2', lastReadSeq: null })
  })

  it('fails loud on a payload without a reader or with a malformed watermark', () => {
    expect(() => readMemberReadRevision({ chat_id: 'chat-1' })).toThrow(/entity_id/)
    expect(() => readMemberReadRevision({ chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: -1 })).toThrow(/last_read_seq/)
    expect(() => readMemberReadRevision({ chat_id: 'chat-1', entity_id: 'user-2', last_read_seq: 'x' })).toThrow(/last_read_seq/)
  })
})

describe('readDeliveryRevision (#5649)', () => {
  it('reads the receipt from a post-migration payload and null for pre-migration rows', () => {
    expect(readDeliveryRevision({ chat_id: 'chat-1', entity_id: 'm1', device_id: 'gugu-agent:agent-1', status: 'read', tombstone: false }))
      .toEqual({ chatId: 'chat-1', messageId: 'm1', receipt: { deviceId: 'gugu-agent:agent-1', status: 'read' } })
    expect(readDeliveryRevision({ chat_id: 'chat-1', entity_id: 'm1', tombstone: false }))
      .toEqual({ chatId: 'chat-1', messageId: 'm1', receipt: null })
  })

  it('fails loud on a malformed receipt', () => {
    expect(() => readDeliveryRevision({ chat_id: 'chat-1' })).toThrow(/entity_id/)
    expect(() => readDeliveryRevision({ chat_id: 'chat-1', entity_id: 'm1', device_id: 'x', status: 'seen' })).toThrow(/receipt/)
    expect(() => readDeliveryRevision({ chat_id: 'chat-1', entity_id: 'm1', status: 'read' })).toThrow(/receipt/)
  })

  it('distinguishes archived-agent refusals from delivered/read receipts', () => {
    const payload = { chat_id: 'chat-1', entity_id: 'm1', device_id: 'gugu-agent:archived',
      status: 'blocked' }
    expect(readDeliveryRevision(payload)).toEqual({ chatId: 'chat-1', messageId: 'm1', receipt: null })
    for (const deviceId of ['', 'gugu-agent:', 'human-device', undefined]) {
      expect(() => readDeliveryRevision({ ...payload, device_id: deviceId })).toThrow(/malformed refusal/)
    }
  })
})

describe('readMessageCreatedRevision (#5649)', () => {
  it('hands back the carried message row, and null for pre-migration rows', () => {
    const row = { id: 'm1', chat_id: 'chat-1', sender_user_id: 'user-2', seq: 3, content: 'hi', content_type: 'text', created_at: '2026-09-15T00:00:00Z' }
    expect(readMessageCreatedRevision({ chat_id: 'chat-1', entity_id: 'm1', tombstone: false, message: row }))
      .toEqual({ chatId: 'chat-1', messageId: 'm1', message: row })
    expect(readMessageCreatedRevision({ chat_id: 'chat-1', entity_id: 'm1', tombstone: false }))
      .toEqual({ chatId: 'chat-1', messageId: 'm1', message: null })
  })

  it('fails loud when the carried row is not the message the key names', () => {
    expect(() => readMessageCreatedRevision({ chat_id: 'chat-1' })).toThrow(/entity_id/)
    expect(() => readMessageCreatedRevision({ chat_id: 'chat-1', entity_id: 'm1', message: { id: 'other' } })).toThrow(/malformed message/)
    expect(() => readMessageCreatedRevision({ chat_id: 'chat-1', entity_id: 'm1', message: 'm1' })).toThrow(/malformed message/)
  })
})

// #7257: App pages hear which files changed — workspace_changed names the file (entity_id), gathered by chat.
describe('readWorkspaceChanges', () => {
  it('a batch of workspace_changed payloads → the files each chat had changed, each once', () => {
    expect(readWorkspaceChanges([
      { chat_id: 'chat-1', entity_id: 'item-a' },
      { chat_id: 'chat-2', entity_id: 'item-c' },
      { chat_id: 'chat-1', entity_id: 'item-b' },
      { chat_id: 'chat-1', entity_id: 'item-a' },
    ])).toEqual([{ chatId: 'chat-1', itemIds: ['item-a', 'item-b'] }, { chatId: 'chat-2', itemIds: ['item-c'] }])
  })

  it('one that names no file is malformed: it fails loud, never a whole-chat read in its place', () => {
    expect(() => readWorkspaceChanges([{ chat_id: 'chat-1', entity_id: 'item-a' }, { chat_id: 'chat-1' }])).toThrow('workspace_changed revision requires entity_id')
  })
})
