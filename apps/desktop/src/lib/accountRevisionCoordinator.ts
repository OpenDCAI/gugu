import type { RawMessageRow } from '@gugu/core/cloud/messageItem'
import { retainMessageDeletion } from './messageHistory'
import {
  createAccountRevisionRuntime,
  type AccountRevisionOperation,
  type AccountRevisionRuntime,
  type AccountRevisionSource,
} from './accountRevisionRuntime'
import type { AccountImRepository } from './imRepository'
import { rendererLogger } from './log'

const coordinatorLog = rendererLogger('chat/account-revision')

const OPERATION_VIEW_PREFIX = 'account-revision-operation:'
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const
export const PRESENCE_TRAILING_DRAIN_MS = 2100

export const ACCOUNT_REVISION_EVENTS = [
  'agent_changed',
  'chat_changed',
  'chat_members_changed',
  'chat_meta_changed',
  'delivery_changed',
  'device_changed',
  'friend_requests_changed',
  'friendship_changed',
  'group_collab_changed',
  'group_invitations_changed',
  'gugu_decision_event',
  'member_read_changed',
  'member_stream_read_changed',
  'message_created',
  'message_deleted',
  'presence_changed',
  'reaction_changed',
  'workspace_changed',
] as const

export type AccountRevisionEvent = typeof ACCOUNT_REVISION_EVENTS[number]
export type AccountRevisionListener = (operations: readonly AccountRevisionOperation[]) => void | Promise<void>

export function readRevisionResourceKey(
  payload: unknown,
  event: AccountRevisionEvent,
): { chatId: string; entityId: string | null } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${event} revision payload is malformed`)
  }
  const key = payload as { chat_id?: unknown; entity_id?: unknown; user_id?: unknown }
  if (typeof key.chat_id !== 'string' || !key.chat_id) {
    throw new Error(`${event} revision payload requires chat_id`)
  }
  if (key.entity_id !== undefined && (typeof key.entity_id !== 'string' || !key.entity_id)) {
    throw new Error(`${event} revision payload has malformed entity_id`)
  }
  // @@@membership-resource-key - Row-trigger revisions name the member with user_id; broadcasts use entity_id.
  if (event === 'chat_members_changed' && key.user_id !== undefined) {
    if (typeof key.user_id !== 'string' || !key.user_id) {
      throw new Error(`${event} revision payload has malformed user_id`)
    }
    if (key.entity_id !== undefined && key.entity_id !== key.user_id) {
      throw new Error(`${event} revision payload has conflicting member ids`)
    }
    return { chatId: key.chat_id, entityId: key.user_id }
  }
  return { chatId: key.chat_id, entityId: key.entity_id ?? null }
}

// @@@5649 member_read_changed 的 resource_key 自迁移 20260915083000 起带 last_read_seq(读者读到哪),
// 客户端直接推进水位,不再为一条回执多跑一次 REST。迁移前落库的旧行没有这个键 ⇒ lastReadSeq 为 null,调用方按旧路补拉。
export function readMemberReadRevision(
  payload: unknown,
): { chatId: string; userId: string; lastReadSeq: number | null } {
  const key = readRevisionResourceKey(payload, 'member_read_changed')
  if (!key.entityId) throw new Error('member_read_changed revision requires entity_id')
  const raw = (payload as { last_read_seq?: unknown }).last_read_seq
  if (raw === undefined || raw === null) return { chatId: key.chatId, userId: key.entityId, lastReadSeq: null }
  const seq = typeof raw === 'string' ? Number(raw) : raw
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('member_read_changed revision has malformed last_read_seq')
  }
  return { chatId: key.chatId, userId: key.entityId, lastReadSeq: seq }
}

// #7257 workspace_changed 由 workspace_items 的行触发器发(publish_workspace_revision),entity_id 总是那份文件。
// App 页面听到的是「这几份文件现在什么样」:按群收拢成一批，缺 entity_id 当畸形载荷响亮失败(不退回整表重拉)。
export function readWorkspaceChanges(payloads: readonly unknown[]): { chatId: string; itemIds: string[] }[] {
  const byChat = new Map<string, Set<string>>()
  for (const payload of payloads) {
    const key = readRevisionResourceKey(payload, 'workspace_changed')
    if (!key.entityId) throw new Error('workspace_changed revision requires entity_id')
    const ids = byChat.get(key.chatId) ?? new Set<string>()
    ids.add(key.entityId)
    byChat.set(key.chatId, ids)
  }
  return [...byChat].map(([chatId, ids]) => ({ chatId, itemIds: [...ids] }))
}

// @@@6470 chat_members_changed 由 chat_members 的行触发器发,INSERT/UPDATE/DELETE 都发(含每一次读水位 UPDATE)。
// sync_since 给每条 payload 并上 tombstone(= TG_OP 'DELETE'),这是分辨「退出」与「加入/行更新」的唯一依据。
// memberId 为 null = 不知道是谁变了(调用方按整读处理)。
export function readMemberRosterRevision(
  payload: unknown,
): { chatId: string; memberId: string | null; left: boolean } {
  const key = readRevisionResourceKey(payload, 'chat_members_changed')
  const tombstone = (payload as { tombstone?: unknown }).tombstone
  if (typeof tombstone !== 'boolean') throw new Error('chat_members_changed revision requires boolean tombstone')
  return { chatId: key.chatId, memberId: key.entityId, left: tombstone }
}

// @@@5649 delivery_changed 的 resource_key 自迁移 20260915083000 起带 device_id/status(谁把 entity_id 这条标成了
// delivered/read),客户端直接打到消息行上,不再重拉整个窗口的覆盖层。旧行没这两个键 ⇒ receipt 为 null,调用方按旧路重验证。
export function readDeliveryRevision(
  payload: unknown,
): { chatId: string; messageId: string; receipt: { deviceId: string; status: 'delivered' | 'read' } | null } {
  const key = readRevisionResourceKey(payload, 'delivery_changed')
  if (!key.entityId) throw new Error('delivery_changed revision requires entity_id')
  const raw = payload as { device_id?: unknown; status?: unknown }
  if (raw.device_id === undefined && raw.status === undefined) return { chatId: key.chatId, messageId: key.entityId, receipt: null }
  if (typeof raw.device_id !== 'string' || !raw.device_id || (raw.status !== 'delivered' && raw.status !== 'read')) {
    throw new Error('delivery_changed revision has malformed receipt')
  }
  return { chatId: key.chatId, messageId: key.entityId, receipt: { deviceId: raw.device_id, status: raw.status } }
}

// @@@5649 message_created 的 payload 自迁移 20260915083000 起由 sync_since 带上消息行本身(messages_view 同形,键 message),
// 客户端直接追加进窗口,不再跑一次「断线补洞」。旧行 / 行已硬删 ⇒ message 为 null,调用方按旧路补洞。
export function readMessageCreatedRevision(
  payload: unknown,
): { chatId: string; messageId: string; message: RawMessageRow | null } {
  const key = readRevisionResourceKey(payload, 'message_created')
  if (!key.entityId) throw new Error('message_created revision requires entity_id')
  const raw = (payload as { message?: unknown }).message
  if (raw === undefined || raw === null) return { chatId: key.chatId, messageId: key.entityId, message: null }
  if (typeof raw !== 'object' || Array.isArray(raw) || (raw as { id?: unknown }).id !== key.entityId) {
    throw new Error('message_created revision has malformed message')
  }
  return { chatId: key.chatId, messageId: key.entityId, message: raw as RawMessageRow }
}

export type AccountRevisionCoordinator = {
  start(): void
  stop(): void
  /**
   * 认领一个或**一组** event。一组 ⇒ 这一批里它认领的全部 operation **一次**交过来
   * (按 revision 正序),而不是每类 event 各叫一次 —— 代价上界按批计,不按 event 数累加。
   */
  subscribe(events: AccountRevisionEvent | readonly AccountRevisionEvent[], listener: AccountRevisionListener): () => void
  retryPending(): void
  whenIdle(): Promise<void>
}

type PendingOperation = {
  key: string
  operation: AccountRevisionOperation
}

export function createAccountRevisionCoordinator(
  accountId: string,
  repository: AccountImRepository,
  source: AccountRevisionSource,
): AccountRevisionCoordinator {
  const runtime: AccountRevisionRuntime = createAccountRevisionRuntime(accountId, repository, source)
  // 一个 registration = 一个 consumer 认领的 event 集合。barrier 只问「这个 event 有人认领吗」,
  // 派发按 registration 而不是按 event 分组 —— 认领了 k 类 event 的 consumer 得到**一次**调用。
  // R3 — 每个 registration 各自记账:它已经成功消费了哪些 revision、连续失败几次、退避到什么时候。
  // 一个 operation 在**所有**认领它的 registration 都消费过之后才确认删除;失败只让失败的那个退避重试,
  // 不再「一个 listener reject ⇒ 整批不确认、全体按 1/2/5/10/30s 重来」—— 从前 device/presence/
  // loadChats 一失败,同批的 message_created 也跟着卡住,新消息「不来」。
  type Registration = {
    events: ReadonlySet<AccountRevisionEvent>
    listener: AccountRevisionListener
    consumed: Set<string>
    failures: number
    retryAt: number | null
  }
  const registrations = new Set<Registration>()
  const claimCounts = new Map<AccountRevisionEvent, number>()
  let active = false
  let dispatching = false
  let dispatchRequested = false
  let dispatchPromise: Promise<void> = Promise.resolve()
  let unsubscribeRepository: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTrailingTimer: ReturnType<typeof setTimeout> | null = null

  for (const event of ACCOUNT_REVISION_EVENTS) {
    claimCounts.set(event, 0)
    runtime.register(event, (operation, transaction) => {
      if (event === 'message_deleted') {
        const { entityId } = readRevisionResourceKey(operation.payload, event)
        if (!entityId) throw new Error('message_deleted revision requires entity_id')
        retainMessageDeletion(repository, transaction, entityId)
      }
      transaction.putView(operationKey(operation.revision), operation)
    })
  }

  const isClaimed = (event: AccountRevisionEvent): boolean => (claimCounts.get(event) ?? 0) > 0

  const pendingOperations = (): PendingOperation[] => repository.snapshot().view
    .filter((row) => row.key.startsWith(OPERATION_VIEW_PREFIX))
    .map((row) => ({ key: row.key, operation: parsePendingOperation(row.value) }))
    .sort((left, right) => compareRevision(left.operation.revision, right.operation.revision))

  const clearRetryTimer = () => {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  const clearPresenceTrailingTimer = () => {
    if (!presenceTrailingTimer) return
    clearTimeout(presenceTrailingTimer)
    presenceTrailingTimer = null
  }

  const schedulePresenceTrailingDrain = () => {
    if (!active) return
    clearPresenceTrailingTimer()
    presenceTrailingTimer = setTimeout(() => {
      presenceTrailingTimer = null
      // Presence rows written during the server suppression window have no
      // realtime wake. Re-read the durable cursor after that window so the
      // final snapshot is not dependent on another mutation arriving later.
      runtime.wake()
    }, PRESENCE_TRAILING_DRAIN_MS)
  }

  // 最早到期的那个退避 registration 到点时再派发一次(派发只叫到期且还有未消费 operation 的)。
  function scheduleRetry() {
    if (!active) return
    clearRetryTimer()
    let earliest: number | null = null
    for (const registration of registrations) {
      if (registration.retryAt !== null && (earliest === null || registration.retryAt < earliest)) earliest = registration.retryAt
    }
    if (earliest === null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      scheduleDispatch()
    }, Math.max(0, earliest - Date.now()))
  }

  function scheduleDispatch() {
    if (!active) return
    clearRetryTimer()
    dispatchRequested = true
    if (dispatching) return
    dispatching = true
    const running = (async () => {
      let firstFailure: { reason: unknown } | null = null
      do {
        dispatchRequested = false
        const ready: PendingOperation[] = []
        for (const pending of pendingOperations()) {
          // 队首无人认领 = barrier:它和它之后的 operation 不得开始派发,也不得被确认。
          if (!isClaimed(pending.operation.event as AccountRevisionEvent)) break
          ready.push(pending)
        }
        if (!active || ready.length === 0) return

        // @@@batch-per-consumer — 一个 consumer 一次调用:它认领的 event 在本 prefix 里的全部
        // operation 按 revision 正序一起交过去。从前这里按 **event** 分组,于是认领了 k 类 event
        // 的 consumer(投影就是)对同一批被叫 k 次,各自做一次有界 revalidation ——
        // 每次都守着自己的上界,合起来却是 k 倍。代价上界按**批**计,不按 event 数累加。
        //
        // @@@parallel-listener-settlement — 同一 ready prefix 内的 listener **并行**结算。
        // 从前这里按注册顺序逐一 await,为的是防止较早的 revalidation 落在较新的状态之后 ——
        // 那个保护现在属于**归并代数**而不属于调度顺序(chat-projection 的按键版本格 join:
        // 每个取数结果带发出时的游标作戳,较早的结果无论何时落地都赢不过较新的)。
        // ⇒ 串行深度按批计,不再按 listener 数累加(#5394 的 40 环有一段就是这么累出来的)。
        const now = Date.now()
        const calls: Array<{ registration: Registration; revisions: string[]; settlement: Promise<void> }> = []
        for (const registration of registrations) {
          const claimed = ready
            .filter((pending) => registration.events.has(pending.operation.event as AccountRevisionEvent)
              && !registration.consumed.has(pending.operation.revision))
            .map((pending) => pending.operation)
          if (claimed.length === 0) continue
          if (registration.retryAt !== null && now < registration.retryAt) continue // 退避中:到点由 retryTimer 再叫
          calls.push({
            registration,
            revisions: claimed.map((operation) => operation.revision),
            settlement: Promise.resolve().then(() => registration.listener(claimed)),
          })
        }
        // allSettled 而不是 all:失败的那个响亮失败并退避,其余 listener 照常结算、照常确认。
        const outcomes = await Promise.allSettled(calls.map((call) => call.settlement))
        if (!active) return
        outcomes.forEach((outcome, index) => {
          const { registration, revisions } = calls[index]!
          if (outcome.status === 'fulfilled') {
            for (const revision of revisions) registration.consumed.add(revision)
            registration.failures = 0
            registration.retryAt = null
            return
          }
          const delay = RETRY_DELAYS_MS[Math.min(registration.failures, RETRY_DELAYS_MS.length - 1)]!
          registration.failures += 1
          registration.retryAt = Date.now() + delay
          coordinatorLog.error({ accountId, events: [...registration.events], revisions, attempt: registration.failures, retryInMs: delay, error: outcome.reason },
            'account revision listener failed; retrying this consumer only')
          firstFailure ??= { reason: outcome.reason }
        })

        // 所有**当前**认领者都消费过的 operation 才确认;没消费完的留在 inbox,等失败的那个重试。
        const acknowledged = ready.filter((pending) => [...registrations].every((registration) =>
          !registration.events.has(pending.operation.event as AccountRevisionEvent)
          || registration.consumed.has(pending.operation.revision)))
        if (acknowledged.length > 0) {
          await repository.transaction((transaction) => {
            for (const pending of acknowledged) transaction.delete('view', [accountId, pending.key])
          })
          for (const registration of registrations) {
            for (const pending of acknowledged) registration.consumed.delete(pending.operation.revision)
          }
          if (acknowledged.some((pending) => pending.operation.event === 'presence_changed')) {
            schedulePresenceTrailingDrain()
          }
        }
        // 失败按 consumer 退避(retryAt),但❌ 在循环里 throw —— 那会把本轮派发期间新到的
        // operation(dispatchRequested)一起拖到失败方的退避定时器才处理;循环跑完再响亮失败。
      } while (active && dispatchRequested)
      if (firstFailure) throw firstFailure.reason
    })()
    dispatchPromise = running
    void running.then(() => {
      dispatching = false
      scheduleRetry()
    }, () => {
      dispatching = false
      scheduleRetry()
    })
  }

  return {
    start() {
      if (active) throw new Error(`account revision coordinator already started for ${accountId}`)
      active = true
      unsubscribeRepository = repository.subscribe(
        (snapshot) => snapshot.view.filter((row) => row.key.startsWith(OPERATION_VIEW_PREFIX)),
        scheduleDispatch,
      )
      runtime.start()
      scheduleDispatch()
    },
    stop() {
      if (!active) return
      active = false
      clearRetryTimer()
      clearPresenceTrailingTimer()
      runtime.stop()
      unsubscribeRepository?.()
      unsubscribeRepository = null
    },
    subscribe(events, listener) {
      const claimed = typeof events === 'string' ? [events] : [...events]
      if (claimed.length === 0) throw new Error('account revision subscribe requires at least one event')
      for (const event of claimed) {
        if (!claimCounts.has(event)) throw new Error(`unknown account revision event: ${event}`)
      }
      const registration: Registration = { events: new Set(claimed), listener, consumed: new Set(), failures: 0, retryAt: null }
      registrations.add(registration)
      for (const event of registration.events) claimCounts.set(event, (claimCounts.get(event) ?? 0) + 1)
      scheduleDispatch()
      return () => {
        if (!registrations.delete(registration)) return
        for (const event of registration.events) claimCounts.set(event, (claimCounts.get(event) ?? 0) - 1)
      }
    },
    retryPending: scheduleDispatch,
    async whenIdle() {
      await runtime.whenIdle()
      await dispatchPromise
    },
  }
}

function operationKey(revision: string): string {
  return `${OPERATION_VIEW_PREFIX}${revision}`
}

function parsePendingOperation(value: unknown): AccountRevisionOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('account revision operation inbox is malformed')
  }
  const operation = value as Partial<AccountRevisionOperation>
  if (typeof operation.revision !== 'string' || !/^[1-9]\d*$/.test(operation.revision)
    || typeof operation.event !== 'string' || !operation.event) {
    throw new Error('account revision operation inbox is malformed')
  }
  return { revision: operation.revision, event: operation.event, payload: operation.payload }
}

function compareRevision(left: string, right: string): number {
  const leftRevision = BigInt(left)
  const rightRevision = BigInt(right)
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0
}
