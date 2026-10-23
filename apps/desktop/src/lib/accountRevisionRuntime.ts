import type { ImRepositoryTransaction, AccountImRepository } from './imRepository'
import { imSelectors } from './imRepository'
import { rendererLogger } from './log'

export const ACCOUNT_REVISION_CURSOR_KEY = 'account-revision-cursor'
const DEFAULT_PAGE_SIZE = 100
// R1 — drain 失败(网络、服务端报错、页序号不连续)后从已提交游标整体重拉的退避节拍。
export const DRAIN_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const
const runtimeLog = rendererLogger('chat/account-revision-runtime')

export type AccountRevisionOperation = {
  revision: string
  event: string
  payload: unknown
}

export type AccountRevisionPage = {
  operations: AccountRevisionOperation[]
  hasMore: boolean
}

type RawRevisionPage = {
  operations?: unknown
  has_more?: unknown
}

export type AccountRevisionSource = {
  syncSince: (cursor: string, limit: number, signal: AbortSignal) => Promise<AccountRevisionPage>
  /**
   * `onWake` 收到的是广播里**服务端此刻的 head revision**(十进制字符串),
   * 拿不到时为 `null` = head 未知。head 是这条通知的全部信息量,也是它的用途:
   * head ≤ 本地 cursor 的 wake 已被本地涵盖,不得因此发 `sync_since`(realtime-catchup)。
   * 订阅恢复走 `onSubscribed`,那一路 head 未知 ⇒ 照旧补拉。
   */
  subscribeWake: (
    accountId: string,
    onWake: (head?: string | null) => void,
    onSubscribed: () => void,
  ) => () => void
}

type RevisionHandler = (
  operation: AccountRevisionOperation,
  transaction: ImRepositoryTransaction,
) => void

export type AccountRevisionRuntime = {
  register: (event: string, handler: RevisionHandler) => void
  start: () => void
  stop: () => void
  wake: (head?: string | null) => void
  whenIdle: () => Promise<void>
}

export function createAccountRevisionRuntime(
  accountId: string,
  repository: AccountImRepository,
  source: AccountRevisionSource,
  pageSize = DEFAULT_PAGE_SIZE,
): AccountRevisionRuntime {
  if (!accountId) throw new Error('account revision runtime requires accountId')
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('account revision runtime requires a positive page size')
  }

  const handlers = new Map<string, RevisionHandler>()
  let started = false
  let active = false
  let generation = 0
  let wakePending = false
  // @@@5649 drain 进行中到达的 wake 只记它的 head(取最大);drain 结束后按这个 head 判是否已被本地游标涵盖,
  // 涵盖就不再发一次注定为空的 sync_since。从前这里无条件补拉一轮,一条已读回执要花两个往返(实测各 ~400 ms)。
  // head 未知(null)的 wake 无法判断 ⇒ 仍无条件补拉。
  let pendingHead: string | null = null
  let unknownHeadPending = false
  let draining = false
  let unsubscribeWake: (() => void) | null = null
  let drainPromise: Promise<void> = Promise.resolve()
  let abortController: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0

  const clearRetryTimer = () => {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  // R1 — 从前 drain 失败只把 draining 复位:不重试、不打日志,要等下一条 wake 才会再拉。wake 是
  // 「有新东西」的广播,不会因为上一次失败再来 ⇒ 失败之后收到的消息一直不出现。现在失败即打日志并按
  // 退避重拉;页被拒(含序号不连续)时游标没动,重拉就是从游标整体再取一遍。
  const scheduleRetry = (error: unknown) => {
    const delay = DRAIN_RETRY_DELAYS_MS[Math.min(retryAttempt, DRAIN_RETRY_DELAYS_MS.length - 1)]!
    retryAttempt += 1
    runtimeLog.error({ accountId, error, attempt: retryAttempt, retryInMs: delay }, 'account revision drain failed; retrying from cursor')
    clearRetryTimer()
    retryTimer = setTimeout(() => {
      retryTimer = null
      scheduleWake()
    }, delay)
  }

  const readCursor = (): string => {
    const value = imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())
    if (value === undefined) throw new Error('account revision cursor requires a snapshot')
    const revision = (value as { revision?: unknown }).revision
    if (!isDecimalRevision(revision, true)) {
      throw new Error('account revision cursor is malformed')
    }
    return revision
  }

  const applyPage = async (
    page: AccountRevisionPage,
    cursor: string,
    runGeneration: number,
  ): Promise<string> => {
    validatePage(page, cursor)
    if (page.operations.length === 0) return cursor
    if (!active || generation !== runGeneration) return cursor

    const lastRevision = page.operations[page.operations.length - 1]!.revision
    await repository.transaction((transaction) => {
      if (!active || generation !== runGeneration) return
      for (const operation of page.operations) {
        const handler = handlers.get(operation.event)
        if (!handler) throw new Error(`unknown account revision event: ${operation.event}`)
        handler(operation, transaction)
      }
      if (!active || generation !== runGeneration) return
      transaction.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: lastRevision })
    })
    return active && generation === runGeneration ? lastRevision : cursor
  }

  // drain 期间到达的 wake 是否还需要再拉一轮:head 未知 ⇒ 要;已知且 ≤ 本地游标 ⇒ 不要。
  const lateWakeNeedsDrain = (): boolean => {
    if (!wakePending) return false
    if (unknownHeadPending || pendingHead === null) return true
    return !isCovered(pendingHead, readCursor())
  }

  const drain = async (runGeneration: number): Promise<void> => {
    do {
      wakePending = false
      pendingHead = null
      unknownHeadPending = false
      let cursor = readCursor()
      let hasMore = true
      while (active && generation === runGeneration && hasMore) {
        const signal = abortController?.signal
        if (!signal) return
        const page = await source.syncSince(cursor, pageSize, signal)
        if (!active || generation !== runGeneration) return
        cursor = await applyPage(page, cursor, runGeneration)
        hasMore = page.hasMore
        if (hasMore && page.operations.length === 0) {
          throw new Error('account revision page claims more rows but is empty')
        }
      }
    } while (active && generation === runGeneration && lateWakeNeedsDrain())
  }

  // @@@head-aware-wake — 广播带 head ⇒ 已被本地涵盖的通知**零往返**。从前每条通知都要花一次
  // `sync_since` 去重新发现自己可能已经知道的事(#5394 的 15 发就是这么来的)。
  const scheduleWake = (head: string | null = null) => {
    if (!active) return
    if (head !== null && isCovered(head, readCursor())) return
    wakePending = true
    if (draining) {
      if (head === null) unknownHeadPending = true
      else pendingHead = pendingHead === null ? head : maxRevision(pendingHead, head)
      return
    }
    draining = true
    clearRetryTimer()
    const runGeneration = generation
    const running = drain(runGeneration)
    drainPromise = running
    void running.then(
      () => {
        draining = false
        retryAttempt = 0
        // drain 的 do-while 已把「需要再拉」的情况留在循环里;走到这里通常 wakePending 已被涵盖,清掉即可。
        // 极窄的窗口(drain 收尾到本回调之间又来一条 wake)仍按 head 判断,不丢。
        if (!active) return
        if (lateWakeNeedsDrain()) {
          const lateHead = unknownHeadPending ? null : pendingHead
          wakePending = false
          scheduleWake(lateHead)
        } else {
          wakePending = false
        }
      },
      (error: unknown) => {
        draining = false
        if (!active || generation !== runGeneration) return
        scheduleRetry(error)
      },
    )
  }

  return {
    register(event, handler) {
      if (!event) throw new Error('account revision handler requires an event')
      if (handlers.has(event)) throw new Error(`duplicate account revision handler: ${event}`)
      handlers.set(event, handler)
    },
    start() {
      if (started) throw new Error(`account revision runtime already started for ${accountId}`)
      started = true
      active = true
      generation += 1
      abortController = new AbortController()
      unsubscribeWake = source.subscribeWake(accountId, scheduleWake, scheduleWake)
      scheduleWake()
    },
    stop() {
      if (!started) return
      active = false
      wakePending = false
      generation += 1
      clearRetryTimer()
      abortController?.abort()
      abortController = null
      unsubscribeWake?.()
      unsubscribeWake = null
    },
    wake: scheduleWake,
    whenIdle() {
      return drainPromise
    },
  }
}

function validatePage(page: AccountRevisionPage, cursor: string): void {
  if (!Array.isArray(page.operations) || typeof page.hasMore !== 'boolean') {
    throw new Error('account revision page is malformed')
  }
  let expected = BigInt(cursor) + 1n
  for (const operation of page.operations) {
    if (
      !isDecimalRevision(operation.revision, false)
      || BigInt(operation.revision) !== expected
      || typeof operation.event !== 'string'
      || !operation.event
    ) {
      throw new Error(`account revision sequence is invalid at ${operation.revision}; expected ${expected}`)
    }
    expected += 1n
  }
}

export function parseRevisionPage(value: unknown): AccountRevisionPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync_since returned a malformed page')
  }
  const raw = value as RawRevisionPage
  if (!Array.isArray(raw.operations) || typeof raw.has_more !== 'boolean') {
    throw new Error('sync_since returned a malformed page')
  }
  return { operations: raw.operations.map(parseOperation), hasMore: raw.has_more }
}

function parseOperation(value: unknown): AccountRevisionOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync_since returned a malformed operation')
  }
  const raw = value as { revision?: unknown; event?: unknown; payload?: unknown }
  if (typeof raw.revision !== 'string' || !/^[1-9]\d*$/.test(raw.revision) || typeof raw.event !== 'string' || !raw.event) {
    throw new Error('sync_since returned a malformed operation')
  }
  return { revision: raw.revision, event: raw.event, payload: raw.payload }
}

function maxRevision(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b
}

/** head ≤ cursor ⇒ 这条 wake 不带新信息。两侧都是十进制字符串,用 BigInt 比,❌ 不用 number。 */
function isCovered(head: string, cursor: string): boolean {
  if (!isDecimalRevision(head, true)) throw new Error('account revision wake head is malformed')
  return BigInt(head) <= BigInt(cursor)
}

function isDecimalRevision(value: unknown, allowZero: boolean): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return false
  return allowZero ? true : value !== '0'
}
