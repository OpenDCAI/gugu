// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import { chat, createReactHarness, deferred } from '../../../support/testHarness'

const boundary = vi.hoisted(() => ({ visible: true, write: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => boundary.visible }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: boundary.write,
}))

const incoming = (): ChatItem => chat({ id: 'tuple-race', kind: 'group', unread_count: 5, last_read_seq: 2,
  next_message_seq: 8, read_state_version: 7, unread_locator: {
    stream_id: 'main:tuple-race', stream_kind: 'main', thread_root_id: null, message_id: 'unread-3', message_seq: 3,
    unread_count: 5, addressed_count: 2, cursor_seq: 2, version: 7, is_marked_unread: false,
  } })
const newer = (): ChatItem => ({ ...incoming(), unread_count: 2, last_read_seq: 3, read_state_version: 8,
  unread_locator: { ...incoming().unread_locator!, message_id: 'unread-6', message_seq: 6,
    unread_count: 2, addressed_count: 1, cursor_seq: 3, version: 8 } })

let repository: AccountImRepository
let harness: ReturnType<typeof createReactHarness>
let binding: ReturnType<typeof useChatProjectionBinding>
let rows: { current: ChatItem[] }
let blocked: boolean
let entered: ReturnType<typeof deferred<void>>
let release: ReturnType<typeof deferred<void>>
let publication: Promise<void> | undefined

beforeEach(async () => {
  boundary.visible = true
  boundary.write.mockReset().mockResolvedValue(undefined)
  blocked = false; entered = deferred<void>(); release = deferred<void>(); publication = undefined
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository('tuple-race-account', { adapter: { ...memory, commit: async operations => {
    if (blocked) { entered.resolve(); await release.promise }
    return memory.commit(operations)
  } } })
  rows = { current: [incoming()] }
  const deps = { ledger: createChatListProjectionLedger(), repositoryRef: { current: repository },
    getRepository: async () => repository, chatsRef: rows, activeChatIdRef: { current: 'tuple-race' }, requestSeqRef: { current: 0 },
    setChats: (next: ChatItem[]) => { rows.current = next }, onActiveRevoked: () => undefined,
    canAcknowledge: () => true, visibleSeqOf: () => 5, notifications: { chatMessages: false, sound: false } }
  function Owner() { binding = useChatProjectionBinding(deps); return null }
  harness = createReactHarness()
  await harness.render(<Owner />)
})

afterEach(async () => {
  release.resolve()
  await publication
  harness.cleanup()
  repository.close()
  vi.restoreAllMocks()
})

async function pausePublication(): Promise<void> {
  blocked = true
  publication = binding.publish([incoming()], [], { requestSeq: 1, notify: false })
  await Promise.race([entered.promise, publication.then(() => { throw new Error('publication did not reach the commit barrier') })])
  expect(boundary.write).not.toHaveBeenCalled()
}

describe('open-chat reads after the actual repository publication await', () => {
  it('uses a newer authoritative tuple that arrives while the snapshot commit is blocked', async () => {
    await pausePublication()
    rows.current = [newer()]
    release.resolve(); await publication
    expect(rows.current[0]).toMatchObject({ unread_count: 2, last_read_seq: 5, read_state_version: 9,
      unread_locator: newer().unread_locator })
    expect(boundary.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'tuple-race', seq: 5 })
  })

  it('never publishes a discarded optimistic tuple over a manual-unread intent arriving during that await', async () => {
    await pausePublication()
    const manual = { ...newer(), is_marked_unread: true }
    rows.current = [manual]
    release.resolve(); await publication
    expect(rows.current[0]).toMatchObject({ unread_count: 2, last_read_seq: 3, read_state_version: 8,
      is_marked_unread: true, unread_locator: manual.unread_locator })
    expect(boundary.write).not.toHaveBeenCalled()
  })

  it('checks visibility after the blocked publication, without sending a read for a now hidden chat', async () => {
    await pausePublication()
    boundary.visible = false
    release.resolve(); await publication
    expect(rows.current[0]).toMatchObject({ unread_count: 5, last_read_seq: 2, read_state_version: 7 })
    expect(boundary.write).not.toHaveBeenCalled()
  })

  it('rolls a failed read back to the complete newer tuple used to prepare it', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    boundary.write.mockRejectedValueOnce(new Error('offline'))
    await pausePublication()
    rows.current = [newer()]
    release.resolve(); await publication
    await Promise.resolve(); await Promise.resolve()
    expect(rows.current[0]).toMatchObject({ unread_count: 2, last_read_seq: 3, read_state_version: 8,
      unread_locator: newer().unread_locator })
    expect(boundary.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'tuple-race', seq: 5 })
    quiet.mockRestore()
  })
})
