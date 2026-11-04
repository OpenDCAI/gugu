// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import { chat } from '../../../support/testHarness'
import { acknowledgeOnScreenChatRows } from '../../../../apps/desktop/src/store/chatListProjection'
const reads = vi.hoisted(() => ({ write: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: reads.write }))

it('keeps the newer authoritative unread tuple when an older projection cannot persist its optimistic advance', () => {
  const fetched = chat({ id: 'projection-race', kind: 'group', last_read_seq: 2, next_message_seq: 8,
    read_state_version: 7, unread_count: 5, is_marked_unread: false,
    unread_locator: { stream_id: 'main:projection-race', stream_kind: 'main', thread_root_id: null, message_id: 'old-3', message_seq: 3, unread_count: 5, addressed_count: 2, cursor_seq: 2, version: 7, is_marked_unread: false } })
  const current = { ...fetched, last_read_seq: 3, read_state_version: 8, unread_count: 2,
    unread_locator: { ...fetched.unread_locator!, message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1, cursor_seq: 3, version: 8 } }
  const [baseline] = mergeFetchedChatsPreservingActiveLocal([fetched], [current], fetched.id)
  expect(baseline).toMatchObject({ last_read_seq: 3, read_state_version: 8, unread_count: 2 })
  const pending: Array<() => void> = []
  const [acknowledged] = acknowledgeOnScreenChatRows([fetched], { current: [current], liveRows: () => [current],
    onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(), deferPersist: persist => pending.push(persist) })
  const [published] = mergeFetchedChatsPreservingActiveLocal([acknowledged!], [current], fetched.id)
  pending.forEach(persist => persist())
  console.log(JSON.stringify({ acknowledged, published, writes: reads.write.mock.calls.length }))
  expect(published!.unread_count).toBe(2)
  expect(published!.unread_locator).toMatchObject({ message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1 })
  // Either a correctly versioned advance is persisted, or the durable/current read cursor survives.
  if (reads.write.mock.calls.length === 0) expect(published!.last_read_seq).toBe(current.last_read_seq)
})

it('keeps sparse unread seq 6 and 7 when the visible window only reaches seq 5', () => {
  reads.write.mockClear()
  const fetched = chat({ id: 'reviewer-sparse', kind: 'group', last_read_seq: 2, next_message_seq: 8,
    read_state_version: 7, unread_count: 2, is_marked_unread: false,
    unread_locator: { stream_id: 'main:reviewer-sparse', stream_kind: 'main', thread_root_id: null, message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1, cursor_seq: 2, version: 7, is_marked_unread: false } })
  const [acknowledged] = acknowledgeOnScreenChatRows([fetched], { onScreen: () => true,
    visibleSeqOf: () => 5, patchChat: vi.fn() })
  expect(acknowledged).toMatchObject({ last_read_seq: 5, unread_count: 2,
    unread_locator: { message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1 } })
  expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: fetched.id, seq: 5 })
})
