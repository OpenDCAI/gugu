// @vitest-environment jsdom
import { act, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createReactHarness } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, replaceChatRowsAndIdentities } from '../../../../apps/desktop/src/lib/imRepository'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'

const reads = vi.hoisted(() => ({ write: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { notifications: false } } }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => true }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: reads.write }))

it('the real projection hook must not overwrite a newer durable unread tuple when its read RPC is discarded', async () => {
  const fetched = chat({ id: 'hook-race', kind: 'group', member_user_ids: [], peer_user_id: null,
    last_read_seq: 2, next_message_seq: 8, read_state_version: 7, unread_count: 5, is_marked_unread: false,
    unread_locator: { stream_id: 'main:hook-race', stream_kind: 'main', thread_root_id: null, message_id: 'old-3', message_seq: 3, unread_count: 5, addressed_count: 2, cursor_seq: 2, version: 7, is_marked_unread: false } })
  const current: ChatItem = { ...fetched, last_read_seq: 3, read_state_version: 8, unread_count: 2,
    unread_locator: { ...fetched.unread_locator!, message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1, cursor_seq: 3, version: 8 } }
  const repository = await openImRepository('review-read-race', { adapter: createMemoryLocalSyncDb() })
  await replaceChatRowsAndIdentities(repository, [current], [])
  const harness = createReactHarness()
  let binding!: ReturnType<typeof useChatProjectionBinding>
  let shown: ChatItem[] = []
  function Owner() {
    const [rows, setRows] = useState([current])
    shown = rows
    const chatsRef = useRef(rows)
    useLayoutEffect(() => { chatsRef.current = rows }, [rows])
    const repositoryRef = useRef(repository)
    const activeChatIdRef = useRef<string | null>(current.id)
    const requestSeqRef = useRef(0)
    const ledger = useRef(createChatListProjectionLedger())
    const getRepository = useCallback(async () => repository, [])
    const canAcknowledge = useCallback(() => true, [])
    const visibleSeqOf = useCallback(() => 5, [])
    const onActiveRevoked = useCallback(() => undefined, [])
    binding = useChatProjectionBinding({ ledger: ledger.current, repositoryRef, getRepository, chatsRef,
      activeChatIdRef, requestSeqRef, canAcknowledge, visibleSeqOf, setChats: setRows, onActiveRevoked,
      notifications: { chatMessages: false, sound: false } })
    return null
  }
  try {
    await harness.render(<Owner />)
    await act(async () => { await binding.publish([fetched], [], { requestSeq: 1, notify: false }) })
    const durable = repository.snapshot().chat.find(row => row.id === current.id)?.value
    console.log(JSON.stringify({ shown: shown[0], durable, readWrites: reads.write.mock.calls.length }))
    expect(shown[0]?.unread_count).toBe(2)
    expect(durable?.unread_count).toBe(2)
    expect(shown[0]?.unread_locator).toMatchObject({ message_id: 'unread-6', message_seq: 6 })
    if (reads.write.mock.calls.length === 0) expect(shown[0]?.last_read_seq).toBe(3)
  } finally { harness.cleanup(); repository.close() }
})
