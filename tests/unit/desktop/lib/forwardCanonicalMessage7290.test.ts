// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createOutboxWiring, type OutboxWiringIo } from '../../../../apps/desktop/src/store/chatOutboxWiring'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, readOutboxRecords } from '../../../../apps/desktop/src/lib/imRepository'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const { attachmentForward, fileShare } = vi.hoisted(() => ({ attachmentForward: vi.fn(), fileShare: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ token: 'fixture' }) }))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), forwardAttachment: attachmentForward, shareAttachment: fileShare }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', () => ({ writeRead: vi.fn(async () => {}) }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); window.localStorage.clear() })
function fixture() {
  const repository = openImRepository('me', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
  let rows: MessageItem[] = []
  const io: OutboxWiringIo = { getImRepository: () => repository, user: () => ({ id: 'me', nickname: 'Me', avatarUrl: null }),
    chats: () => [], identity: () => undefined, activeChatId: () => 'destination', activeThreadRootId: () => null,
    setMessagesAndCache: update => { rows = update(rows) }, setThreadMessages: () => {}, patchChat: vi.fn(), toast: vi.fn(),
    appendMessage: row => { rows = [...rows.filter(r => r.id !== row.id), row] },
  }
  return { wiring: createOutboxWiring(io), repository, rows: () => rows }
}
function source(type = 'text'): MessageItem {
  return { id: 'source', chat_id: 'origin', sender_user_id: 'other', content: 'selected body', content_type: type as MessageItem['content_type'],
    seq: 3, reactions: [], to_user_ids: ['private-reader'], is_whisper: true, reply_to_message_id: null, retracted_at: null,
    created_at: new Date(0).toISOString(), is_mine: false, delivered: true, delivery_status: null }
}
it('queues the selected body and forwards text with one stable id, without a source lookup', async () => {
  const f = fixture()
  const lookup = vi.spyOn(chatService, 'getMessageById')
  const send = vi.spyOn(chatService, 'sendMessage').mockImplementation(async (chat, actor, content, id) => ({ ...source(), id, chat_id: chat, sender_user_id: actor, content, seq: 10 }))
  await f.wiring.forward(source(), 'destination', 'me')
  const id = f.rows()[0].id
  await f.wiring.outbox.delivered(id)
  expect(send).toHaveBeenCalledWith('destination', 'me', 'selected body', id, 'text', expect.objectContaining({ forwardedFromMessageId: 'source', isWhisper: false, toUserIds: null }))
  expect(lookup).not.toHaveBeenCalled()
  expect(readOutboxRecords(await f.repository)).toEqual([])
  f.wiring.dispose()
})
it('attachment forwarding uses the server operation with the same queued id', async () => {
  const f = fixture()
  attachmentForward.mockImplementation(async (_endpoint, args) => ({ ...source('attachment'), id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, seq: 10 }))
  const send = vi.spyOn(chatService, 'sendMessage')
  await f.wiring.forward(source('attachment'), 'destination', 'me')
  const id = f.rows()[0].id
  await f.wiring.outbox.delivered(id)
  expect(attachmentForward).toHaveBeenCalledWith(expect.anything(), { source_message_id: 'source', message_id: id, chat_id: 'destination', sender_user_id: 'me', to_user_ids: [] })
  expect(send).not.toHaveBeenCalled()
  f.wiring.dispose()
})

it('folder file forwarding reuses its queued id after a lost response and never uploads bytes', async () => {
  vi.useFakeTimers()
  const f = fixture()
  fileShare.mockRejectedValueOnce(new TypeError('response lost')).mockImplementation(async (_endpoint, args) => ({
    ...source('attachment'), id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, seq: 10,
  }))
  await f.wiring.forward({ itemId: 'file-id', version: 4, document: false, name: 'proof.pdf' }, 'destination', 'me')
  const id = f.rows()[0].id
  const delivered = f.wiring.outbox.delivered(id)
  await vi.advanceTimersByTimeAsync(2000)
  await delivered
  expect(fileShare.mock.calls.map(([, args]) => args)).toEqual([
    { item_id: 'file-id', version: 4, message_id: id, chat_id: 'destination', sender_user_id: 'me' },
    { item_id: 'file-id', version: 4, message_id: id, chat_id: 'destination', sender_user_id: 'me' },
  ])
  f.wiring.dispose()
})
