import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { message } from '../../../support/testHarness'
type QueryResult = { data: unknown[] | null; error: { message: string } | null }
const { queryResults, queryCalls, chatDbMock } = vi.hoisted(() => {
  type HoistedQueryResult = { data: unknown[] | null; error: { message: string } | null }
  type HoistedQueryCall = {
    table: string
    columns: string | null
    filters: Array<{ op: 'in' | 'is' | 'eq' | 'not'; field: string; value: unknown; operator?: string }>
  }
  const queryResults = new Map<string, HoistedQueryResult[]>()
  const queryCalls: HoistedQueryCall[] = []
  function nextResult(table: string): HoistedQueryResult {
    const queue = queryResults.get(table) ?? []
    return queue.shift() ?? { data: [], error: null }
  }
  const chatDbMock = {
    from: vi.fn((table: string) => {
      const call: HoistedQueryCall = { table, columns: null, filters: [] }
      queryCalls.push(call)
      const chain: {
        select: ReturnType<typeof vi.fn>
        in: ReturnType<typeof vi.fn>
        is: ReturnType<typeof vi.fn>
        eq: ReturnType<typeof vi.fn>
        not: ReturnType<typeof vi.fn>
        then: Promise<HoistedQueryResult>['then']
      } = {
        select: vi.fn((columns: string) => {
          call.columns = columns
          return chain
        }),
        in: vi.fn((field: string, value: unknown) => {
          call.filters.push({ op: 'in', field, value })
          return chain
        }),
        is: vi.fn((field: string, value: unknown) => {
          call.filters.push({ op: 'is', field, value })
          return chain
        }),
        eq: vi.fn((field: string, value: unknown) => {
          call.filters.push({ op: 'eq', field, value })
          return chain
        }),
        not: vi.fn((field: string, operator: string, value: unknown) => {
          call.filters.push({ op: 'not', field, operator, value })
          return chain
        }),
        then: (resolve, reject) => Promise.resolve(nextResult(table)).then(resolve, reject),
      }
      return chain
    }),
  }
  return { queryResults, queryCalls, chatDbMock }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: chatDbMock,
}))
import {
  applyMessageWindowRevalidation,
  applyMessageOverlays,
  loadMessageOverlays,
  revalidateMessageWindow,
} from '../../../../apps/desktop/src/lib/chatMessageRevalidation'
function setResults(table: string, ...results: QueryResult[]) {
  queryResults.set(table, [...results])
}
describe('chatMessageRevalidation', () => {
  beforeEach(() => {
    queryResults.clear()
    queryCalls.length = 0
    vi.clearAllMocks()
  })
  it('loads reaction and delivery overlays with the same per-message read semantics', async () => {
    setResults('message_reactions', {
      data: [
        { message_id: 'm1', user_id: 'viewer', emoji: '👍' },
        { message_id: 'm1', user_id: 'peer', emoji: '👍' },
        { message_id: 'm2', user_id: 'peer', emoji: '👀' },
      ],
      error: null,
    })
    setResults('message_deliveries', {
      data: [
        { message_id: 'm1', status: 'delivered', device_id: 'gugu-agent:viewer' },
        { message_id: 'm1', status: 'read', device_id: 'gugu-agent:agent-a' },
        { message_id: 'm2', status: 'delivered', device_id: 'gugu-agent:viewer' },
        { message_id: 'm2', status: 'read', device_id: 'gugu-agent:viewer' },
      ],
      error: null,
    })
    const overlays = await loadMessageOverlays(['m1', 'm2', 'm3'], 'viewer')
    expect(overlays.get('m1')).toEqual({
      reactions: [{ emoji: '👍', count: 2, my_reaction: true }],
      delivered: true,
      delivery_status: 'delivered',
      readers: ['agent-a'],
    })
    expect(overlays.get('m2')).toEqual({
      reactions: [{ emoji: '👀', count: 1, my_reaction: false }],
      delivered: true,
      delivery_status: 'read',
      readers: ['viewer'],
    })
    expect(overlays.get('m3')).toEqual({
      reactions: [],
      delivered: false,
      delivery_status: null,
      readers: [],
    })
  })
  it('applies overlays to fetched message items without refetching bodies', async () => {
    setResults('message_reactions', {
      data: [{ message_id: 'm1', user_id: 'viewer', emoji: '👍' }],
      error: null,
    })
    setResults('message_deliveries', {
      data: [{ message_id: 'm1', status: 'read', device_id: 'gugu-agent:viewer' }],
      error: null,
    })
    const items: MessageItem[] = [message({ id: 'm1', content: 'body' })]
    await expect(applyMessageOverlays(items, 'viewer')).resolves.toMatchObject([
      {
        id: 'm1',
        content: 'body',
        reactions: [{ emoji: '👍', count: 1, my_reaction: true }],
        delivered: true,
        delivery_status: 'read',
        readers: ['viewer'],
      },
    ])
    expect(queryCalls.map((call) => call.table)).toEqual(['message_reactions', 'message_deliveries'])
  })
  it('revalidates window body mutations and keeps deleted ids out of presentIds', async () => {
    setResults('message_reactions', { data: [], error: null })
    setResults('message_deliveries', { data: [], error: null })
    setResults('messages_view', {
      data: [
        {
          id: 'm1',
          chat_id: 'c1',
          sender_user_id: 'u1',
          seq: 7,
          created_at: '2026-07-03T00:00:00.000Z',
          content: 'edited body',
          content_type: 'attachment',
          retracted_at: '2026-07-03T00:01:00.000Z',
        },
      ],
      error: null,
    })
    const result = await revalidateMessageWindow(['m1', 'deleted'], 'viewer')
    expect([...result.presentIds]).toEqual(['m1'])
    expect(result.mutations.get('m1')).toEqual({
      content: 'edited body',
      content_type: 'attachment',
      retracted_at: '2026-07-03T00:01:00.000Z',
    })
    expect(result.overlays.get('deleted')).toMatchObject({ delivered: false, reactions: [] })
    const bodyCall = queryCalls.find((call) => call.table === 'messages_view')
    expect(bodyCall?.filters).toEqual([
      { op: 'in', field: 'id', value: ['m1', 'deleted'] },
      { op: 'is', field: 'deleted_at', value: null },
      { op: 'eq', field: 'is_imported_history_root', value: false },
      { op: 'not', field: 'deleted_for_user_ids', operator: 'cs', value: JSON.stringify(['viewer']) },
    ])
  })
  it('treats a failed body revalidation chunk as present unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setResults('message_reactions', { data: [], error: null })
    setResults('message_deliveries', { data: [], error: null })
    setResults('messages_view', { data: null, error: { message: 'network down' } })
    const result = await revalidateMessageWindow(['m1', 'm2'], 'viewer')
    expect([...result.presentIds]).toEqual(['m1', 'm2'])
    expect(result.mutations.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      '[chat] window body revalidation failed (offset 0/2): network down'
    )
    warn.mockRestore()
  })
  it('does not delete a persisted row that arrived after the queried snapshot was captured', () => {
    const queried = message({ id: 'queried', seq: 1 })
    const arrivedWhileRequestWasInFlight = message({ id: 'late-human', seq: 2 })
    const next = applyMessageWindowRevalidation(
      [queried, arrivedWhileRequestWasInFlight],
      new Set([queried.id]),
      { overlays: new Map(), mutations: new Map(), presentIds: new Set([queried.id]) },
    )
    expect(next.map((row) => row.id)).toEqual(['queried', 'late-human'])
  })
  it('still drops an id that this exact request queried and confirmed absent', () => {
    const deleted = message({ id: 'deleted', seq: 1 })
    expect(applyMessageWindowRevalidation(
      [deleted],
      new Set([deleted.id]),
      { overlays: new Map(), mutations: new Map(), presentIds: new Set() },
    )).toEqual([])
  })
  it('never drops an optimistic row', () => {
    const optimistic = message({ id: 'optimistic', seq: -1 })
    expect(applyMessageWindowRevalidation(
      [optimistic],
      new Set(),
      { overlays: new Map(), mutations: new Map(), presentIds: new Set() },
    )).toEqual([optimistic])
  })
})
