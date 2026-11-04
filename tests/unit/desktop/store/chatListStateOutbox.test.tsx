// @vitest-environment jsdom
import { act, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, message, createReactHarness, deferred } from '../../../support/testHarness'
import { useChatListState } from '../../../../apps/desktop/src/store/chatListState'
import { patchChatRows, type PatchChat } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import { createOutboxWiring } from '../../../../apps/desktop/src/store/chatOutboxWiring'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, putOutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

const boundary = vi.hoisted(() => ({ visible: true, write: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { notifications: false } } }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => boundary.visible }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: boundary.write,
}))
afterEach(() => { vi.restoreAllMocks(); boundary.write.mockReset() })

it.each(['send', 'restore-native'] as const)('%s read failure cannot be resurrected by a later hidden publication', async mode => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const basis = chat({ id: 'outbox-read', kind: 'group', member_user_ids: [], next_message_seq: 8,
    last_read_seq: 3, read_state_version: 8, unread_count: 2, is_marked_unread: false,
    unread_locator: { stream_id: 'main:outbox-read', stream_kind: 'main', thread_root_id: null,
      message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1,
      cursor_seq: 3, version: 8, is_marked_unread: false } })
  const expected = { last_read_seq: basis.last_read_seq, read_state_version: basis.read_state_version,
    unread_count: basis.unread_count, is_marked_unread: basis.is_marked_unread, unread_locator: basis.unread_locator }
  const read = deferred<void>(); boundary.visible = true; boundary.write.mockReturnValueOnce(read.promise)
  const repository = await openImRepository('outbox-owner', { adapter: createMemoryLocalSyncDb() })
  const rendered = createReactHarness()
  let rows!: { current: ChatItem[] }, patch!: PatchChat, binding!: ReturnType<typeof useChatProjectionBinding>
  function Owner() {
    const [, setRows, current] = useChatListState([basis]); rows = current
    patch = (id, partial, version) => setRows(previous => patchChatRows(previous, id, partial, version))
    const ledger = useRef(createChatListProjectionLedger()), repositoryRef = useRef(repository)
    const activeChatIdRef = useRef<string | null>(basis.id), requestSeqRef = useRef(0)
    binding = useChatProjectionBinding({ ledger: ledger.current, repositoryRef, chatsRef: current,
      activeChatIdRef, requestSeqRef, getRepository: async () => repository, setChats: setRows,
      canAcknowledge: () => true, visibleSeqOf: () => 5, onActiveRevoked: () => undefined,
      notifications: { chatMessages: false, sound: false } })
    return null
  }
  await rendered.render(<Owner />)
  const delivered = message({ id: 'own-sent', chat_id: basis.id, sender_user_id: 'outbox-owner', seq: 7,
    is_mine: true, content: 'sent', content_type: mode === 'send' ? 'text' : 'attachment' })
  vi.spyOn(chatService, 'sendMessage').mockResolvedValue(delivered)
  vi.spyOn(chatService, 'getMessageById').mockResolvedValue(delivered)
  const wiring = createOutboxWiring({ getImRepository: async () => repository,
    user: () => ({ id: 'outbox-owner', nickname: 'Owner', avatarUrl: null }), identity: () => undefined,
    chats: () => rows.current, activeChatId: () => basis.id, activeThreadRootId: () => null,
    setMessagesAndCache: () => undefined, setThreadMessages: () => undefined,
    patchChat: (...args) => patch(...args), toast: () => undefined, appendMessage: () => undefined })
  let stop: (() => void) | undefined
  try {
    if (mode === 'send') {
      await act(async () => { await wiring.enqueue({ id: delivered.id, chatId: basis.id, senderUserId: 'outbox-owner',
        content: 'sent', toUserIds: [], replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false }) })
    } else {
      const now = new Date().toISOString()
      await putOutboxRecord(repository, { clientMessageId: delivered.id, chatId: basis.id, senderUserId: 'outbox-owner',
        payload: { content: 'native.txt', contentType: 'attachment', toUserIds: [], replyToMessageId: null,
          threadRootId: null, isThreadRoot: false, isWhisper: false },
        operation: { kind: 'nativeAttachment', commit: { message_id: delivered.id, chat_id: basis.id,
          sender_user_id: 'outbox-owner', file_name: 'native.txt', to_user_ids: [] } },
        state: 'sending', attempts: 0, lastError: null, enqueuedAt: now, updatedAt: now })
      await act(async () => { stop = wiring.restoreAndWatch() })
    }
    await vi.waitFor(() => expect(boundary.write).toHaveBeenCalledTimes(1))
    expect(rows.current[0]).toMatchObject({ read_state_version: 9, last_read_seq: 7, unread_count: 0 })
    boundary.visible = false
    await act(async () => { await binding.publish([{ ...basis, read_state_version: 7 }], [], { requestSeq: 1, notify: false }) })
    await act(async () => { read.reject(new Error('offline')); await Promise.resolve() })
    expect(rows.current[0]).toMatchObject(expected)
    await act(async () => { await binding.publish([{ ...basis, read_state_version: 7 }], [], { requestSeq: 2, notify: false }) })
    expect(rows.current[0]).toMatchObject(expected)
    expect(boundary.write).toHaveBeenCalledTimes(1)
  } finally { stop?.(); wiring.dispose(); rendered.cleanup(); repository.close() }
})
