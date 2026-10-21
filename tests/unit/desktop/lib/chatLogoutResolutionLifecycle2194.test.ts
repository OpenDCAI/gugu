// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abortAuthSessionBoundary,
  currentAuthSessionSignal,
  resetAuthSessionBoundary,
} from '../../../../apps/desktop/src/lib/authSessionLoss'
const chatFrom = vi.fn()
const chatRpc = vi.fn()
const identityFrom = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: chatFrom, rpc: chatRpc },
  identityDb: { from: identityFrom, rpc: vi.fn() },
  dataClient: { storage: { from: vi.fn() } },
  getCurrentAuthUserId: vi.fn(async () => 'owner-1'),
}))
const { createChatProjection } = await import('../../../../apps/desktop/src/lib/chatProjection')
/** 会话列表的取数入口 —— 冷启也走投影(spec I7),所以被测对象是它的 `hydrate`。 */
function hydrateChatList(): Promise<unknown> {
  return createChatProjection('owner-1').hydrate('0', currentAuthSessionSignal())
}
function queryResult<T>(result: T | Promise<T>): Record<string, unknown> {
  const promise = Promise.resolve(result)
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'neq', 'is', 'not', 'gt', 'lt', 'or', 'order', 'limit']) {
    query[method] = vi.fn(() => query)
  }
  query.abortSignal = vi.fn(() => query)
  query.then = promise.then.bind(promise)
  return query
}
function pendingAbortableQuery() {
  let resolveQuery: (value: { data: unknown[] | null; error: null }) => void = () => {}
  let rejectQuery: (reason?: unknown) => void = () => {}
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const pending = new Promise<{ data: unknown[] | null; error: null }>((resolve, reject) => {
    resolveQuery = resolve
    rejectQuery = reject
  })
  const query = queryResult(pending)
  const originalThen = query.then as Promise<unknown>['then']
  query.then = ((...args: Parameters<Promise<unknown>['then']>) => {
    markStarted()
    return originalThen(...args)
  }) as Promise<unknown>['then']
  query.abortSignal = vi.fn((signal: AbortSignal) => {
    const abort = () => rejectQuery(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return query
  })
  return { query, started, resolveQuery }
}
/**
 * ⚠️ 按**表名**分发,不按调用顺序:投影的族读是**并行**的(族间并发),
 * 顺序桩(`mockReturnValueOnce` 链)表达不了它,而且顺序一变就会静默喂错数据。
 */
function mockDmReads(identityUsersQuery: Record<string, unknown>): void {
  chatFrom.mockImplementation((table: string) => {
    if (table === 'chat_members') {
      return queryResult({
        data: [
          { chat_id: 'dm-1', user_id: 'owner-1', last_read_seq: 0, is_marked_unread: false, version: 0,
            notification_level: 'all', is_pinned: false, updated_at: '2026-07-18T00:00:00.000Z',
            joined_at: '2026-07-18T00:00:00.000Z', inbox_published_at: '2026-07-18T00:00:00.000Z' },
          { chat_id: 'dm-1', user_id: 'peer-1', last_read_seq: 0, is_marked_unread: false, version: 0,
            notification_level: 'all', is_pinned: false, updated_at: '2026-07-18T00:00:00.000Z',
            joined_at: '2026-07-18T00:00:00.000Z', inbox_published_at: '2026-07-18T00:00:00.000Z' },
        ],
        error: null,
      })
    }
    if (table === 'chats') {
      return queryResult({
        data: [{
          id: 'dm-1', public_id: null, kind: 'dm', status: 'active', name: null, avatar_url: null,
          created_at: '2026-07-18T00:00:00.000Z', last_message_at: null, last_message_preview: null,
          next_message_seq: 0, pinned_message_id: null,
        }],
        error: null,
      })
    }
    return queryResult({ data: [], error: null })
  })
  chatRpc.mockReturnValue(queryResult({ data: [], error: null }))
  identityFrom.mockReturnValue(identityUsersQuery)
}
beforeEach(() => {
  resetAuthSessionBoundary()
})
afterEach(() => {
  vi.restoreAllMocks()
  chatFrom.mockReset()
  chatRpc.mockReset()
  identityFrom.mockReset()
})
describe('DM resolution across user-initiated logout', () => {
  it('aborts the old auth lifecycle before an in-flight identity read can report unresolved', async () => {
    const identityUsers = pendingAbortableQuery()
    mockDmReads(identityUsers.query)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = hydrateChatList()
    await identityUsers.started
    abortAuthSessionBoundary()
    identityUsers.resolveQuery({ data: null, error: null })
    const result = await Promise.allSettled([pending])
    expect({
      status: result[0]?.status,
      abortName: result[0]?.status === 'rejected' ? (result[0].reason as Error)?.name : null,
      resolutionFailures: errorSpy.mock.calls
        .filter(([message]) => String(message).includes('unresolved dm chat name')).length,
    }).toEqual({
      status: 'rejected',
      abortName: 'AbortError',
      resolutionFailures: 0,
    })
  })
  it('leaves an unresolved DM identity unpublished instead of projecting name:"" while auth remains active', async () => {
    mockDmReads(queryResult({ data: null, error: null }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(hydrateChatList()).resolves.toEqual([])
    expect(
      errorSpy.mock.calls.filter(([message]) => String(message).includes('unresolved dm chat name dm-1')),
    ).toHaveLength(0)
  })
})
