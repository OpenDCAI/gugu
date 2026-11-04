// @vitest-environment jsdom
import { mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import { act, useRef, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createReactHarness } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { useChatListState } from '../../../../apps/desktop/src/store/chatListState'
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
let updateRows: Dispatch<SetStateAction<ChatItem[]>>

beforeEach(async () => {
  boundary.visible = 'reviewer-tuple'; boundary.write.mockReset().mockResolvedValue(undefined)
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository('reviewer-tuple-account', { adapter: memory })
  function Owner() {
    const [rows, setRows, chatsRef] = useChatListState([tuple()]); shown = rows; updateRows = setRows
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
  harness.cleanup(); repository.close(); vi.restoreAllMocks()
})

it('accepts publications and functional list writes without an asynchronous act batch', async () => {
  const newer = tuple(10, 4, 1, 7)
  // Deliberately leave both completions outside an asynchronous act batch.
  await binding.publish([newer], [], { requestSeq: 1, notify: false })
  updateRows(previous => [...previous])
  await binding.publish([tuple()], [], { requestSeq: 2, notify: false })
  await act(async () => { await Promise.resolve() })
  expect(shown[0]).toMatchObject({ unread_count: 1, last_read_seq: 5, read_state_version: 11, unread_locator: newer.unread_locator })
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it.each([8, 10])('accepts authoritative version %s when an older publication started first', async version => {
  const newer = tuple(version, 3, 2, 6)
  let first!: Promise<void>, second!: Promise<void>
  act(() => {
    first = binding.publish([tuple()], [], { requestSeq: 1, notify: false })
    second = binding.publish([newer], [], { requestSeq: 2, notify: false })
  })
  await Promise.all([first, second])
  await act(async () => { await Promise.resolve() })
  expect(shown[0]).toMatchObject({ unread_count: 2, last_read_seq: 5, read_state_version: version + 1, unread_locator: newer.unread_locator })
})

it('reports a failed publication and still accepts another publication without retrying the failure', async () => {
  const commit = vi.spyOn(repository, 'transaction').mockRejectedValueOnce(new Error('commit failed'))
  const failed = binding.publish([tuple()], [], { requestSeq: 1, notify: false })
  const failure = expect(failed).rejects.toThrow('commit failed')
  const newer = tuple(10, 4, 1, 7)
  const next = binding.publish([newer], [], { requestSeq: 2, notify: false })
  await failure
  await act(async () => { await next })
  expect(shown[0]).toMatchObject({ unread_count: 1, last_read_seq: 5, read_state_version: 11, unread_locator: newer.unread_locator })
  expect(commit).toHaveBeenCalledTimes(2)
  expect(boundary.write).toHaveBeenCalledTimes(1)
})

it('still preserves a complete unversioned cached tuple when its cursor is ahead', () => {
  const cached = tuple(0, 5, 2, 6)
  const [merged] = mergeFetchedChatsPreservingActiveLocal([tuple(0)], [cached], cached.id)
  expect(merged).toMatchObject(cached)
})
