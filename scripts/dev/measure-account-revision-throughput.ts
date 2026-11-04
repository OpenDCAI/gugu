import { performance } from 'node:perf_hooks'
import process from 'node:process'
import {
  createAccountRevisionCoordinator,
  type AccountRevisionListener,
} from '../../apps/desktop/src/lib/accountRevisionCoordinator'
import type {
  AccountRevisionOperation,
  AccountRevisionSource,
} from '../../apps/desktop/src/lib/accountRevisionRuntime'
import { openImRepository } from '../../apps/desktop/src/lib/imRepository'
import {
  createMemoryLocalSyncDb,
  type LocalImDbAdapter,
  type LocalImDbOperation,
} from '../../apps/desktop/src/lib/localSyncDb'

const OPERATION_COUNT = 200
const SOURCE_PAGE_DELAY_MS = 220
const LISTENER_DELAY_MS = 390

type CommitMetrics = {
  calls: number
  operations: number
  wallMs: number
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function measuredAdapter(metrics: CommitMetrics): LocalImDbAdapter {
  const delegate = createMemoryLocalSyncDb()
  return {
    loadAccount: (accountId) => delegate.loadAccount(accountId),
    async commit(operations: readonly LocalImDbOperation[]) {
      const startedAt = performance.now()
      await delegate.commit(operations)
      metrics.calls += 1
      metrics.operations += operations.length
      metrics.wallMs += performance.now() - startedAt
    },
    close: () => delegate.close(),
  }
}

function operationCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 1
}

async function main(): Promise<void> {
  const commits: CommitMetrics = { calls: 0, operations: 0, wallMs: 0 }
  const repository = await openImRepository('throughput-account', { adapter: measuredAdapter(commits) })
  let sourceCalls = 0
  const source: AccountRevisionSource = {
    async syncSince(cursor, limit) {
      sourceCalls += 1
      await wait(SOURCE_PAGE_DELAY_MS)
      const first = Number(cursor) + 1
      const remaining = OPERATION_COUNT - first + 1
      const count = Math.max(0, Math.min(limit, remaining))
      const operations: AccountRevisionOperation[] = Array.from({ length: count }, (_, index) => ({
        revision: String(first + index),
        event: 'chat_changed',
        payload: { chat_id: `chat-${(first + index) % 10}` },
      }))
      return { operations, hasMore: first + count <= OPERATION_COUNT }
    },
    subscribeWake(_accountId, _onWake, onSubscribed) {
      onSubscribed()
      return () => undefined
    },
  }
  const coordinator = createAccountRevisionCoordinator('throughput-account', repository, source)

  const ingestStartedAt = performance.now()
  coordinator.start()
  await coordinator.whenIdle()
  const ingestMs = performance.now() - ingestStartedAt
  const pendingAfterIngest = repository.snapshot().view.length
  const ingestCommits = { ...commits }

  commits.calls = 0
  commits.operations = 0
  commits.wallMs = 0
  let listenerCalls = 0
  let deliveredOperations = 0
  const listener = (async (operationOrBatch: unknown) => {
    listenerCalls += 1
    deliveredOperations += operationCount(operationOrBatch)
    await wait(LISTENER_DELAY_MS)
  }) as AccountRevisionListener

  const dispatchStartedAt = performance.now()
  coordinator.subscribe('chat_changed', listener)
  await coordinator.whenIdle()
  const dispatchMs = performance.now() - dispatchStartedAt
  const pendingAfterDispatch = repository.snapshot().view.length
  coordinator.stop()
  repository.close()

  if (pendingAfterIngest !== OPERATION_COUNT || pendingAfterDispatch !== 0 || deliveredOperations !== OPERATION_COUNT) {
    throw new Error(JSON.stringify({ pendingAfterIngest, pendingAfterDispatch, deliveredOperations }))
  }

  process.stdout.write(`${JSON.stringify({
    config: {
      operations: OPERATION_COUNT,
      pageSize: 100,
      sourcePageDelayMs: SOURCE_PAGE_DELAY_MS,
      listenerDelayMs: LISTENER_DELAY_MS,
    },
    ingest: {
      elapsedMs: Number(ingestMs.toFixed(1)),
      operationsPerSecond: Number((OPERATION_COUNT * 1000 / ingestMs).toFixed(2)),
      sourceCalls,
      commits: ingestCommits.calls,
      commitOperations: ingestCommits.operations,
      commitWallMs: Number(ingestCommits.wallMs.toFixed(1)),
      pending: pendingAfterIngest,
    },
    dispatch: {
      elapsedMs: Number(dispatchMs.toFixed(1)),
      operationsPerSecond: Number((OPERATION_COUNT * 1000 / dispatchMs).toFixed(2)),
      listenerCalls,
      listenerWallBudgetMs: listenerCalls * LISTENER_DELAY_MS,
      commits: commits.calls,
      commitOperations: commits.operations,
      commitWallMs: Number(commits.wallMs.toFixed(1)),
      pending: pendingAfterDispatch,
    },
  }, null, 2)}\n`)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
