// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOutboxWiring, type OutboxWiringIo } from '../../../../apps/desktop/src/store/chatOutboxWiring'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, readOutboxRecords } from '../../../../apps/desktop/src/lib/imRepository'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const { attachmentForward, fileShare, prepare, commit, resolveFile, disposeFile, nativeSend } = vi.hoisted(() => ({
  attachmentForward: vi.fn(), fileShare: vi.fn(), prepare: vi.fn(), commit: vi.fn(), resolveFile: vi.fn(), disposeFile: vi.fn(), nativeSend: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ token: 'fixture' }), prepareChatAttachment: prepare }))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), forwardAttachment: attachmentForward, shareAttachment: fileShare, commitAttachment: commit }))
vi.mock('../../../../apps/desktop/src/lib/attachmentSendRecovery', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentSendRecovery')>(), settleAttachmentSend: nativeSend }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ resolveFile, fileReader: (actorId: string) => ({ accountId: 'me', actorId }), fileReadSignal: () => new AbortController().signal }))
vi.mock('@gugu/core/shared/fileResolver', async original => ({ ...await original<typeof import('@gugu/core/shared/fileResolver')>(), snapshotBlob: async () => new Blob(['abc']) }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(), writeRead: vi.fn(async () => {}) }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:fixture')
    static revokeObjectURL = vi.fn()
  })
  resolveFile.mockImplementation(async () => ({ status: 'ready', revision: { size_bytes: 3 }, dispose: disposeFile }))
  prepare.mockImplementation(async (_endpoint, _file, scope) => ({ staging_key: `staged-${scope.request_id}` }))
  commit.mockImplementation(async (_endpoint, args) => ({ ...source('attachment'), id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, seq: 11 }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.localStorage.clear() })
function fixture(adapter = createMemoryLocalSyncDb()) {
  const repository = openImRepository('me', { adapter, storage: window.localStorage })
  let rows: MessageItem[] = []
  const io: OutboxWiringIo = { getImRepository: () => repository, user: () => ({ id: 'me', nickname: 'Me', avatarUrl: null }),
    chats: () => [], identity: () => undefined, activeChatId: () => 'destination', activeThreadRootId: () => null,
    setMessagesAndCache: update => { rows = update(rows) }, setThreadMessages: () => {}, patchChat: vi.fn(), toast: vi.fn(),
    appendMessage: row => { rows = [...rows.filter(r => r.id !== row.id), row] },
  }
  return { wiring: createOutboxWiring(io), repository, adapter, io, rows: () => rows }
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

const ref = { itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }
function task(files = [ref]): MessageItem {
  return { ...source('card'), content: JSON.stringify({ v: 1, type: 'task', text: 'read these', deviceId: 'device', machineLabel: 'Computer',
    agentUserId: 'agent', agentName: 'Agent', sessionId: 'session', projectId: 'project', files }) }
}
function acknowledgeCard() {
  return vi.spyOn(chatService, 'sendMessage').mockImplementation(async (chat, actor, content, id) => ({ ...source('card'), id, chat_id: chat, sender_user_id: actor, content, seq: 10 }))
}

it('persists prepared files and their card dependency before a queued card is sent, then replays in order after restart', async () => {
  const f = fixture()
  const send = vi.spyOn(chatService, 'sendMessage').mockImplementation(() => new Promise(() => {}))
  await f.wiring.forward(task(), 'destination', 'me')
  const stored = readOutboxRecords(await f.repository)
  const card = stored.find(row => row.payload.contentType === 'card')!
  const attachment = stored.find(row => row.operation?.kind === 'attachment')!
  expect(attachment).toMatchObject({ dependsOn: card.clientMessageId, state: 'pending', operation: { commit: { message_id: attachment.clientMessageId } } })
  expect(commit).not.toHaveBeenCalled()
  f.wiring.dispose()
  const order: string[] = []
  send.mockImplementation(async (chat, actor, content, id) => {
    order.push(id); return { ...source('card'), id, chat_id: chat, sender_user_id: actor, content, seq: 10 }
  })
  commit.mockImplementation(async (_endpoint, args) => {
    order.push(args.message_id)
    return { ...source('attachment'), id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, seq: 11 }
  })
  const recovered = fixture(f.adapter)
  await recovered.wiring.outbox.restore()
  await recovered.wiring.outbox.delivered(attachment.clientMessageId)
  expect(order).toEqual([card.clientMessageId, attachment.clientMessageId])
  expect(resolveFile).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledOnce()
  expect(readOutboxRecords(await recovered.repository)).toEqual([])
  recovered.wiring.dispose()
})

it('resolves as the forwarding person, skips unreadable files, warns by name and retains the card and readable files', async () => {
  const f = fixture()
  acknowledgeCard()
  resolveFile.mockImplementation(async (reference, reader) => {
    expect(reader).toEqual({ accountId: 'me', actorId: 'me' })
    return reference.item_id === 'denied' ? { status: 'gone' } : { status: 'ready', revision: { size_bytes: 3 }, dispose: disposeFile }
  })
  await f.wiring.forward(task([ref, { ...ref, itemId: 'denied', name: 'private.txt' }, { ...ref, itemId: 'last' }]), 'destination', 'me')
  await Promise.all(f.rows().filter(row => row.content_type === 'attachment').map(row => f.wiring.outbox.delivered(row.id)))
  expect(f.rows().filter(row => row.content_type === 'card')).toHaveLength(1)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(commit).toHaveBeenCalledTimes(2)
  expect(disposeFile).toHaveBeenCalledTimes(2)
  expect(resolveFile).toHaveBeenNthCalledWith(2, { item_id: 'denied', version: 1 }, { accountId: 'me', actorId: 'me' }, expect.anything())
  expect(f.io.toast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('private.txt'), 'warning')
  f.wiring.dispose()
})

it('keeps the same card and file UUID through lost responses and retries without resolving or staging the file again', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const send = acknowledgeCard()
  send.mockRejectedValueOnce(new TypeError('card response lost'))
  commit.mockRejectedValueOnce(new TypeError('file response lost'))
  await f.wiring.forward(task(), 'destination', 'me')
  const ids = f.rows().map(row => row.id)
  const delivered = f.wiring.outbox.delivered(ids[1])
  await vi.advanceTimersByTimeAsync(4_000)
  await delivered
  expect(send.mock.calls.map(args => args[3])).toEqual([ids[0], ids[0]])
  expect(commit.mock.calls.map(([, args]) => args.message_id)).toEqual([ids[1], ids[1]])
  expect(resolveFile).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledOnce()
  expect(readOutboxRecords(await f.repository)).toEqual([])
  f.wiring.dispose()
})

it('preserves the native storage decision and publishes only after its card is acknowledged', async () => {
  const f = fixture()
  let confirmCard!: (message: MessageItem) => void
  vi.spyOn(chatService, 'sendMessage').mockImplementation(() => new Promise(resolve => { confirmCard = resolve }))
  prepare.mockImplementation(async (_endpoint, file) => ({ local: file }))
  nativeSend.mockImplementation(async ({ commit: args }) => ({ ...source('attachment'), id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, seq: 11 }))
  const forwarding = f.wiring.forward(task(), 'destination', 'me')
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  expect(nativeSend).not.toHaveBeenCalled()
  const card = f.rows().find(row => row.content_type === 'card')!
  confirmCard({ ...card, seq: 10, delivered: true })
  await forwarding
  await f.wiring.outbox.delivered(f.rows().find(row => row.content_type === 'attachment')!.id)
  expect(nativeSend).toHaveBeenCalledOnce()
  expect(commit).not.toHaveBeenCalled()
  f.wiring.dispose()
})

it('keeps a failed prepared-file intent visible and continues other files without the batch discard catch', async () => {
  const f = fixture()
  acknowledgeCard()
  prepare.mockRejectedValueOnce(new Error('upload unavailable'))
  await f.wiring.forward(task([ref, { ...ref, itemId: 'last' }]), 'destination', 'me')
  await f.wiring.outbox.delivered(f.rows().filter(row => row.content_type === 'attachment')[1].id)
  const failed = readOutboxRecords(await f.repository)
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({ state: 'failed', operation: { kind: 'upload' } })
  expect(f.rows().some(row => row.id === failed[0].clientMessageId)).toBe(true)
  expect(commit).toHaveBeenCalledOnce()
  expect(f.io.toast).toHaveBeenCalledOnce()
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
