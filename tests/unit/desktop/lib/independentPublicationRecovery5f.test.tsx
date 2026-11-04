// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createReactHarness, deferred } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import { advanceReadWatermark, patchChatRows, type PatchChat } from '../../../../apps/desktop/src/store/chatRealtimeMutations'

const boundary = vi.hoisted(() => ({ visible: true, write: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { notifications: false } } }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => boundary.visible }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: boundary.write,
}))

const tuple = (version = 7, cursor = 2, unread = 5, first = 3): ChatItem => chat({
  id: 'independent-recovery', kind: 'group', member_user_ids: [], next_message_seq: 8,
  last_read_seq: cursor, read_state_version: version, unread_count: unread, is_marked_unread: false,
  unread_locator: { stream_id: 'main:independent-recovery', stream_kind: 'main', thread_root_id: null,
    message_id: `unread-${first}`, message_seq: first, unread_count: unread, addressed_count: 1,
    cursor_seq: cursor, version, is_marked_unread: false },
})

let repository: AccountImRepository
let harness: ReturnType<typeof createReactHarness>
let binding: ReturnType<typeof useChatProjectionBinding>
let shown: ChatItem[]
let setRows: Dispatch<SetStateAction<ChatItem[]>>
let rootPatch: PatchChat
let commitCount: number
let failCommit: boolean
let repositoryCalls: number
let gateFirst: boolean
let gate: ReturnType<typeof deferred<void>>
let allPublications: Promise<void>[]

function publish(row: ChatItem, seq: number): Promise<void> {
  const promise = binding.publish([row], [], { requestSeq: seq, notify: false })
  allPublications.push(promise)
  void promise.catch(() => undefined) // Test cleanup owns failures; assertions below still inspect them.
  return promise
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('publication stalled')), 2000) })]) }
  finally { clearTimeout(timer) }
}

beforeEach(async () => {
  boundary.visible = true; boundary.write.mockReset().mockResolvedValue(undefined)
  commitCount = 0; failCommit = false; repositoryCalls = 0; gateFirst = false; gate = deferred<void>(); allPublications = []
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository('independent-recovery-account', { adapter: { ...memory, commit: async operations => {
    commitCount++
    if (failCommit) { failCommit = false; throw new Error('adapter commit failed') }
    return memory.commit(operations)
  } } })
  function Owner() {
    const [rows, update] = useState<ChatItem[]>([tuple()]); shown = rows; setRows = update
    const chatsRef = useRef(rows)
    useLayoutEffect(() => { chatsRef.current = rows }, [rows])
    const ledger = useRef(createChatListProjectionLedger())
    const repositoryRef = useRef(repository), activeChatIdRef = useRef<string | null>('independent-recovery'), requestSeqRef = useRef(0)
    rootPatch = (id, partial, expected) => update(previous => patchChatRows(previous, id, partial, expected))
    binding = useChatProjectionBinding({ ledger: ledger.current, repositoryRef, chatsRef, activeChatIdRef, requestSeqRef,
      getRepository: async () => { repositoryCalls++; if (gateFirst && repositoryCalls === 1) await gate.promise; return repository },
      setChats: update, onActiveRevoked: () => undefined, canAcknowledge: () => true, visibleSeqOf: () => 5,
      notifications: { chatMessages: false, sound: false } })
    return null
  }
  harness = createReactHarness(); await harness.render(<Owner />)
})

afterEach(async () => {
  gate.resolve(); await Promise.allSettled(allPublications)
  harness.cleanup(); repository.close(); vi.restoreAllMocks()
})

it.each([
  ['newer-first, FIFO completion', true, false], ['older-first, FIFO completion', false, false],
  ['newer-first, reversed completion', true, true], ['older-first, reversed completion', false, true],
] as const)('%s keeps the complete newer tuple', async (_, newerFirst, reversed) => {
  const newer = tuple(10, 4, 1, 7)
  gateFirst = reversed
  let first!: Promise<void>, second!: Promise<void>
  const settled: string[] = []
  act(() => {
    first = publish(newerFirst ? newer : tuple(), 1).then(() => { settled.push('first') })
    second = publish(newerFirst ? tuple() : newer, 2).then(() => { settled.push('second') })
  })
  if (reversed) { await bounded(second); gate.resolve() }
  await bounded(Promise.all([first, second]))
  await act(async () => { await Promise.resolve() })
  expect(settled).toEqual(reversed ? ['second', 'first'] : ['first', 'second'])
  expect(shown[0]).toMatchObject({ read_state_version: 11, last_read_seq: 5, unread_count: 1, unread_locator: newer.unread_locator })
})

it('a real adapter commit failure does not poison the repository or stall the next publication', async () => {
  const before = commitCount; failCommit = true
  const first = publish(tuple(8, 3, 2, 6), 1)
  const failure = expect(first).rejects.toThrow('adapter commit failed')
  const newer = tuple(10, 4, 1, 7)
  const next = publish(newer, 2)
  await failure; await act(async () => { await bounded(next) })
  expect(commitCount - before).toBe(2)
  expect(boundary.write).toHaveBeenCalledTimes(1)
  expect(shown[0]).toMatchObject({ read_state_version: 11, unread_count: 1, unread_locator: newer.unread_locator })
})

it('a hook-owned failed read stays rolled back on the next hidden publication', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const read = deferred<void>(); boundary.write.mockReturnValueOnce(read.promise)
  const basis = tuple(8, 3, 2, 6)
  await act(async () => { await publish(basis, 1) })
  expect(shown[0]).toMatchObject({ read_state_version: 9, last_read_seq: 5 })
  await act(async () => { read.reject(new Error('offline')); await Promise.resolve() })
  expect(shown[0]).toMatchObject(basis)
  boundary.visible = false
  await act(async () => { await publish(tuple(), 2) })
  expect(shown[0]).toMatchObject(basis)
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it('a store-owned failed tail read must not be resurrected by the accepted publication mirror', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const basis = tuple(8, 3, 2, 6), read = deferred<void>()
  boundary.write.mockReturnValueOnce(read.promise)
  await act(async () => { setRows([basis]) })
  // This is ChatProvider's actual external read path and functional PatchChat contract.
  act(() => { advanceReadWatermark(shown, basis.id, 7, rootPatch) })
  expect(shown[0]).toMatchObject({ last_read_seq: 7, unread_count: 0, read_state_version: 9 })
  // The user hides the chat while the already-started store read is still in flight.
  boundary.visible = false
  await act(async () => { await publish(tuple(), 1) })
  await act(async () => { read.reject(new Error('offline')); await Promise.resolve() })
  expect(shown[0]).toMatchObject(basis)
  await act(async () => { await publish(tuple(), 2) })
  expect(shown[0]).toMatchObject(basis)
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it.each([
  ['higher server version beats an older higher cursor', 10, 3, 8, 7, true],
  ['versioned server beats an unversioned higher cursor', 10, 3, 0, 7, true],
  ['higher local version preserves its complete tuple', 8, 3, 10, 7, false],
  ['versioned local beats an unversioned snapshot', 0, 3, 10, 7, false],
  ['equal nonzero versions use the incoming complete tuple', 10, 3, 10, 7, true],
  ['two unversioned cached rows preserve active cursor compatibility', 0, 3, 0, 7, false],
] as const)('%s', (_, fv, fc, lv, lc, incomingWins) => {
  const fetched = tuple(fv, fc, 2, 6), local = tuple(lv, lc, 1, 7)
  const [merged] = mergeFetchedChatsPreservingActiveLocal([fetched], [local], fetched.id)
  const winner = incomingWins ? fetched : local
  expect(merged).toMatchObject({ last_read_seq: winner.last_read_seq, read_state_version: winner.read_state_version,
    unread_count: winner.unread_count, unread_locator: winner.unread_locator })
})
