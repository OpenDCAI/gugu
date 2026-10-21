import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => {
  const chatKinds = new Map<string, 'dm' | 'ai' | 'group'>()
  let requestedChatId = ''
  const rows: unknown[] = []
  const pages: unknown[][] = []
  const requestedCursors: string[] = []
  const requestedPageSizes: number[] = []
  const messageQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    not: vi.fn(),
    like: vi.fn(),
    order: vi.fn(),
    or: vi.fn(),
    limit: vi.fn(),
  }
  const chatQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  }
  const memberQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    limit: vi.fn(),
  }
  const from = vi.fn((table: string) => {
    if (table === 'chats') return chatQuery
    if (table === 'messages') return messageQuery
    if (table === 'chat_members') return memberQuery
    throw new Error(`unexpected table ${table}`)
  })
  return {
    chatKinds,
    rows,
    pages,
    requestedCursors,
    requestedPageSizes,
    messageQuery,
    chatQuery,
    memberQuery,
    from,
    get requestedChatId() { return requestedChatId },
    set requestedChatId(value: string) { requestedChatId = value },
  }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: mocks.from },
}))
const {
  IMPORTED_HISTORY_ROOT_PREFIX,
  IMPORTED_HISTORY_TURN_PREFIX,
  IMPORTED_HISTORY_PAGE_SIZE,
  groupImportedHistoryRows,
  loadImportedSessionHistories,
} = await import('../../../../apps/desktop/src/lib/importedHistoryReader')
const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
const row = (overrides: Record<string, unknown>) => ({
  id: 'root-1',
  chat_id: 'dm-1',
  sender_user_id: 'owner-1',
  seq: 1,
  content: '已导入的 Codex 会话 · session.jsonl',
  content_type: 'text',
  client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000001`,
  thread_root_id: null,
  is_thread_root: true,
  created_at: '2026-07-30T00:00:00.000Z',
  ...overrides,
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.chatKinds.clear()
  mocks.chatKinds.set('dm-1', 'dm')
  mocks.requestedChatId = ''
  mocks.rows.splice(0)
  mocks.pages.splice(0)
  mocks.requestedCursors.splice(0)
  mocks.requestedPageSizes.splice(0)
  mocks.chatQuery.select.mockReturnValue(mocks.chatQuery)
  mocks.chatQuery.eq.mockImplementation((_column: string, value: string) => {
    mocks.requestedChatId = value
    return mocks.chatQuery
  })
  mocks.chatQuery.maybeSingle.mockImplementation(async () => ({
    data: mocks.chatKinds.has(mocks.requestedChatId) ? { kind: mocks.chatKinds.get(mocks.requestedChatId) } : null,
    error: null,
  }))
  mocks.messageQuery.select.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.eq.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.is.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.not.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.like.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.order.mockReturnValue(mocks.messageQuery)
  mocks.messageQuery.or.mockImplementation((cursor: string) => {
    mocks.requestedCursors.push(cursor)
    return mocks.messageQuery
  })
  mocks.messageQuery.limit.mockImplementation(async (size: number) => {
    const pageIndex = mocks.requestedPageSizes.length
    mocks.requestedPageSizes.push(size)
    return { data: [...(mocks.pages[pageIndex] ?? (pageIndex === 0 ? mocks.rows : []))], error: null }
  })
  mocks.memberQuery.select.mockReturnValue(mocks.memberQuery)
  mocks.memberQuery.eq.mockReturnValue(mocks.memberQuery)
  mocks.memberQuery.neq.mockReturnValue(mocks.memberQuery)
  mocks.memberQuery.limit.mockResolvedValue({ data: [{ user_id: 'agent-1' }], error: null })
})
describe('imported history marker contract', () => {
  it('groups only marker-backed roots and turns in chronological order', () => {
    const histories = groupImportedHistoryRows([
      row({ id: 'ordinary-root', content: '已导入的 Codex 会话 · title-only', client_message_id: 'ordinary-message' }),
      row({ id: 'turn-2', seq: 3, sender_user_id: 'agent-1', content: 'second', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000003`, thread_root_id: 'root-1', is_thread_root: false }),
      row({ id: 'root-1' }),
      row({ id: 'turn-1', seq: 2, content: 'first', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'root-1', is_thread_root: false }),
    ], 'dm-1', 'owner-1', 'agent-1')
    expect(histories).toHaveLength(1)
    expect(histories[0]).toMatchObject({ rootId: 'root-1', title: '已导入的 Codex 会话 · session.jsonl' })
    expect(histories[0].turns.map((turn) => [turn.content, turn.role])).toEqual([
      ['first', 'user'],
      ['second', 'assistant'],
    ])
  })
  // #6822 导入的原话里,咕咕投递进去的那几轮带着信封:面板只画正文。
  it('shows a delivered turn as its body', () => {
    const envelope = '<gugu_delivery route="chat" from="Ada" from_id="user:ada" chat="7" chat_kind="dm" msg="msg:1" at="t">'
      + '<![CDATA[帮我看下这个]]><arrival>Sent to you through 咕咕</arrival></gugu_delivery>'
    const [history] = groupImportedHistoryRows([
      row({ id: 'root-1' }),
      row({ id: 'turn-1', seq: 2, content: envelope, client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'root-1', is_thread_root: false }),
    ], 'dm-1', 'owner-1', 'agent-1')
    expect(history.turns.map((turn) => turn.content)).toEqual(['帮我看下这个'])
  })
  it('fails loud when a marked turn has no marked root', () => {
    expect(() => groupImportedHistoryRows([
      row({ id: 'turn-1', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'missing-root', is_thread_root: false }),
    ], 'dm-1', 'owner-1', 'agent-1')).toThrow(/orphan imported-history turn/)
  })
  it.each([
    ['bare root marker', row({ id: 'root-bad', client_message_id: IMPORTED_HISTORY_ROOT_PREFIX })],
    ['non-uuid turn marker', row({ id: 'turn-1', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}not-a-uuid`, thread_root_id: 'root-1', is_thread_root: false })],
    ['non-text root', row({ id: 'root-bad', content_type: 'attachment', client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000099` })],
    ['root from the peer', row({ id: 'root-bad', sender_user_id: 'agent-1', client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000099` })],
    ['turn marked as root', row({ id: 'turn-1', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'root-1', is_thread_root: true })],
  ])('fails loud for malformed producer rows: %s', (_label, malformed) => {
    expect(() => groupImportedHistoryRows([
      row({ id: 'root-1', client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000001` }),
      malformed,
    ], 'dm-1', 'owner-1', 'agent-1')).toThrow(/invalid imported-history/)
  })
  it('rejects duplicate marked turn ids', () => {
    expect(() => groupImportedHistoryRows([
      row({ id: 'root-1', client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000001` }),
      row({ id: 'turn-1', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'root-1', is_thread_root: false }),
      row({ id: 'turn-1', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000003`, thread_root_id: 'root-1', is_thread_root: false }),
    ], 'dm-1', 'owner-1', 'agent-1')).toThrow(/duplicate imported-history row turn-1/)
  })
  it('rejects a marked turn from anyone other than the owner or exact DM peer', () => {
    expect(() => groupImportedHistoryRows([
      row({ id: 'root-1', client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}00000000-0000-4000-8000-000000000001` }),
      row({ id: 'turn-1', sender_user_id: 'third-party', client_message_id: `${IMPORTED_HISTORY_TURN_PREFIX}00000000-0000-4000-8000-000000000002`, thread_root_id: 'root-1', is_thread_root: false }),
    ], 'dm-1', 'owner-1', 'agent-1')).toThrow(/unexpected sender third-party/)
  })
  it('loads marker rows from the RLS-protected messages table without opening generic threads', async () => {
    mocks.rows.push(row({ id: uuid(1), client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(1)}` }))
    await expect(loadImportedSessionHistories('dm-1', 'owner-1')).resolves.toHaveLength(1)
    expect(mocks.from).toHaveBeenCalledWith('chat_members')
    expect(mocks.memberQuery.limit).toHaveBeenCalledWith(2)
    expect(mocks.from).toHaveBeenCalledWith('messages')
    expect(mocks.messageQuery.is).toHaveBeenCalledWith('deleted_at', null)
    expect(mocks.messageQuery.not).toHaveBeenCalledWith('deleted_for_user_ids', 'cs', JSON.stringify(['owner-1']))
    expect(mocks.messageQuery.like).toHaveBeenCalledWith('client_message_id', 'session-import-%')
    expect(mocks.messageQuery.order).toHaveBeenNthCalledWith(1, 'seq', { ascending: true })
    expect(mocks.messageQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true })
  })
  it('uses the previous seq/id keyset when an earlier visible prefix disappears between pages', async () => {
    mocks.pages.push(
      Array.from({ length: IMPORTED_HISTORY_PAGE_SIZE }, (_, index) => row({
        id: uuid(index + 1),
        seq: index + 1,
        client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(index + 1)}`,
      })),
      [row({
        id: uuid(IMPORTED_HISTORY_PAGE_SIZE + 1),
        seq: IMPORTED_HISTORY_PAGE_SIZE + 1,
        client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(IMPORTED_HISTORY_PAGE_SIZE + 1)}`,
      })],
    )
    await expect(loadImportedSessionHistories('dm-1', 'owner-1')).resolves.toHaveLength(IMPORTED_HISTORY_PAGE_SIZE + 1)
    expect(mocks.requestedPageSizes).toEqual([IMPORTED_HISTORY_PAGE_SIZE, IMPORTED_HISTORY_PAGE_SIZE])
    expect(mocks.requestedCursors).toEqual([
      `seq.gt.${IMPORTED_HISTORY_PAGE_SIZE},and(seq.eq.${IMPORTED_HISTORY_PAGE_SIZE},id.gt.${uuid(IMPORTED_HISTORY_PAGE_SIZE)})`,
    ])
    expect('range' in mocks.messageQuery).toBe(false)
  })
  it('rejects rows that violate stable seq/id page ordering', async () => {
    mocks.pages.push([
      row({ id: uuid(2), seq: 2, client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(2)}` }),
      row({ id: uuid(1), seq: 1, client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(1)}` }),
    ])
    await expect(loadImportedSessionHistories('dm-1', 'owner-1')).rejects.toThrow(/pagination order/)
  })
  it('rejects duplicate ids across imported-history pages', async () => {
    mocks.pages.push(
      Array.from({ length: IMPORTED_HISTORY_PAGE_SIZE }, (_, index) => row({
        id: uuid(index + 1),
        seq: index + 1,
        client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(index + 1)}`,
      })),
      [row({
        id: uuid(IMPORTED_HISTORY_PAGE_SIZE),
        seq: IMPORTED_HISTORY_PAGE_SIZE + 1,
        client_message_id: `${IMPORTED_HISTORY_ROOT_PREFIX}${uuid(IMPORTED_HISTORY_PAGE_SIZE + 1)}`,
      })],
    )
    await expect(loadImportedSessionHistories('dm-1', 'owner-1')).rejects.toThrow(/duplicate imported-history row/)
  })
  it('does not turn the imported-history reader into a group thread path', async () => {
    mocks.chatKinds.set('group-1', 'group')
    await expect(loadImportedSessionHistories('group-1', 'owner-1')).rejects.toThrow(/group chats use the group history surface/)
    expect(mocks.from).not.toHaveBeenCalledWith('messages')
  })
  it('fails loud unless the private chat has exactly one peer', async () => {
    mocks.memberQuery.limit.mockResolvedValue({ data: [], error: null })
    await expect(loadImportedSessionHistories('dm-1', 'owner-1')).rejects.toThrow(/requires exactly one DM peer/)
  })
})
