// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createReactHarness, deferred } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'

const boundary = vi.hoisted(() => ({ visible: 'reviewer-tuple', write: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { notifications: false } } }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: (id: string) => boundary.visible === id }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: boundary.write,
}))

const tuple = (version = 7, cursor = 2, unread = 5, first = 3): ChatItem => chat({
  id: 'reviewer-tuple', kind: 'group', member_user_ids: [], next_message_seq: 8,
  last_read_seq: cursor, read_state_version: version, unread_count: unread, is_marked_unread: false,
  unread_locator: { stream_id: 'main:reviewer-tuple', stream_kind: 'main', thread_root_id: null,
    message_id: `unread-${first}`, message_seq: first, unread_count: unread, addressed_count: 1,
    cursor_seq: cursor, version, is_marked_unread: false },
})

let repository: AccountImRepository
let harness: ReturnType<typeof createReactHarness>
let binding: ReturnType<typeof useChatProjectionBinding>
let shown: ChatItem[]
let replace: (next: ChatItem[]) => void
let blocked: boolean
let entered: ReturnType<typeof deferred<void>>
let release: ReturnType<typeof deferred<void>>
let publication: Promise<void> | undefined

beforeEach(async () => {
  boundary.visible = 'reviewer-tuple'; boundary.write.mockReset().mockResolvedValue(undefined)
  blocked = false; entered = deferred<void>(); release = deferred<void>(); publication = undefined
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository('reviewer-tuple-account', { adapter: { ...memory, commit: async operations => {
    if (blocked) { entered.resolve(); await release.promise }
    return memory.commit(operations)
  } } })
  function Owner() {
    const [rows, setRows] = useState<ChatItem[]>([tuple()]); shown = rows; replace = setRows
    const chatsRef = useRef(rows)
    useLayoutEffect(() => { chatsRef.current = rows }, [rows])
    const ledger = useRef(createChatListProjectionLedger())
    const repositoryRef = useRef(repository), activeChatIdRef = useRef<string | null>('reviewer-tuple'), requestSeqRef = useRef(0)
    binding = useChatProjectionBinding({ ledger: ledger.current, repositoryRef, chatsRef, activeChatIdRef, requestSeqRef,
      getRepository: async () => repository, setChats: setRows, onActiveRevoked: () => undefined,
      canAcknowledge: () => true, visibleSeqOf: () => 5, notifications: { chatMessages: false, sound: false } })
    return null
  }
  harness = createReactHarness(); await harness.render(<Owner />)
})

afterEach(async () => {
  release.resolve(); await publication
  harness.cleanup(); repository.close(); vi.restoreAllMocks()
})

async function pausePublication(row = tuple()) {
  blocked = true
  publication = binding.publish([row], [], { requestSeq: 1, notify: false })
  await Promise.race([entered.promise, publication.then(() => { throw new Error('missing commit barrier') })])
  expect(boundary.write).not.toHaveBeenCalled()
}

async function finishPublication() { await act(async () => { release.resolve(); await publication }) }

it('uses all fields of the latest higher-version tuple delivered during the commit wait with a real React ref', async () => {
  await pausePublication()
  const latest = tuple(12, 4, 1, 7)
  await act(async () => { replace([latest]) })
  await finishPublication()
  expect(shown[0]).toMatchObject({ unread_count: 1, last_read_seq: 5, read_state_version: 13, unread_locator: latest.unread_locator })
  expect(boundary.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: latest.id, seq: 5 })
})

it('keeps the newer snapshot tuple when current state is older', async () => {
  const snapshot = tuple(10, 4, 1, 7)
  await act(async () => { replace([tuple(8, 3, 2, 6)]) })
  await pausePublication(snapshot); await finishPublication()
  expect(shown[0]).toMatchObject({ unread_count: 1, last_read_seq: 5, read_state_version: 11, unread_locator: snapshot.unread_locator })
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it('does not advance backwards or write again when the later tuple has passed the visible cursor', async () => {
  await pausePublication()
  const latest = tuple(12, 6, 1, 7)
  await act(async () => { replace([latest]) }); await finishPublication()
  expect(shown[0]).toMatchObject(latest)
  expect(boundary.write).not.toHaveBeenCalled()
})

it('preserves the complete later manual-unread tuple without a main read', async () => {
  await pausePublication()
  const latest = { ...tuple(12, 3, 2, 6), is_marked_unread: true }
  await act(async () => { replace([latest]) }); await finishPublication()
  expect(shown[0]).toMatchObject(latest)
  expect(boundary.write).not.toHaveBeenCalled()
})

it('preserves a later thread locator without confirming the main stream', async () => {
  await pausePublication()
  const latest = tuple(12, 3, 2, 6)
  latest.unread_locator = { ...latest.unread_locator!, stream_id: 'thread:reviewer-tuple:root', stream_kind: 'thread', thread_root_id: 'root' }
  await act(async () => { replace([latest]) }); await finishPublication()
  expect(shown[0]).toMatchObject(latest)
  expect(boundary.write).not.toHaveBeenCalled()
})

it('does not acknowledge a chat that becomes hidden before the commit completes', async () => {
  await pausePublication()
  boundary.visible = 'other-chat'; await finishPublication()
  expect(shown[0]).toMatchObject(tuple())
  expect(boundary.write).not.toHaveBeenCalled()
})

it('a failed older read cannot roll back a still newer complete tuple', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const read = deferred<void>(); boundary.write.mockReturnValueOnce(read.promise)
  await pausePublication()
  await act(async () => { replace([tuple(8, 3, 2, 6)]) }); await finishPublication()
  expect(shown[0]).toMatchObject({ last_read_seq: 5, read_state_version: 9 })
  const latest = tuple(11, 6, 1, 7)
  await act(async () => { replace([latest]) })
  await act(async () => { read.reject(new Error('offline')); await Promise.resolve(); await Promise.resolve() })
  expect(shown[0]).toMatchObject(latest)
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it('overlapping newer-then-older publications do not replace the newer tuple', async () => {
  const newer = tuple(8, 3, 2, 6)
  await act(async () => {
    await Promise.all([
      binding.publish([newer], [], { requestSeq: 1, notify: false }),
      binding.publish([tuple()], [], { requestSeq: 2, notify: false }),
    ])
  })
  expect(shown[0]).toMatchObject({ unread_count: 2, last_read_seq: 5, read_state_version: 9, unread_locator: newer.unread_locator })
})

it('overlapping publications also preserve the newer tuple without an async act around their completions', async () => {
  const newer = tuple(8, 3, 2, 6)
  let first!: Promise<void>, second!: Promise<void>
  act(() => {
    first = binding.publish([newer], [], { requestSeq: 1, notify: false })
    second = binding.publish([tuple()], [], { requestSeq: 2, notify: false })
  })
  await Promise.all([first, second])
  await act(async () => { await Promise.resolve() })
  expect(shown[0]).toMatchObject({ unread_count: 2, last_read_seq: 5, read_state_version: 9, unread_locator: newer.unread_locator })
})
