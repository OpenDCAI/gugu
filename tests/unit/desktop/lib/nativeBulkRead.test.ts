// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReadTarget } from '../../../../apps/desktop/src/lib/readWriter'
import { addNativeReplies, seeNativeReplies, unreadNativeMessages } from '@gugu/session-core/session-record/native-read'
import { chat } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ rpc: vi.fn(), write: vi.fn<(target: ReadTarget) => Promise<void>>(), manual: vi.fn(async () => {}) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', async original => ({ ...await original<object>(), chatDb: { rpc: io.rpc } }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async original => ({ ...await original<object>(), writeRead: io.write }))
vi.mock('../../../../apps/desktop/src/store/chatRealtimeMutations', () => ({ persistManualUnread: io.manual }))
const { markChatsReadAndRefresh, markManualUnreadAndRefresh } = await import('../../../../apps/desktop/src/lib/chatUnreadLocator')
const refresh = vi.fn(async () => {})
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const native = (conversationId = 's', itemIds = ['old'], chatId?: string) => ({ deviceId: 'host', conversationId, itemIds, ...(chatId ? { chatId } : {}) })
const manual = () => markManualUnreadAndRefresh('dm', { chats: [], patchChat: vi.fn(), toast: vi.fn(), refresh })
beforeEach(() => {
  vi.clearAllMocks()
  io.rpc.mockResolvedValue({ data: [], error: null })
  io.write.mockImplementation(async () => {})
  io.manual.mockImplementation(async () => {})
})

it('batches exact click-time native identities and leaves a reply arriving during the write unread', async () => {
  const keys = Array.from({ length: 1001 }, (_, i) => `reply-${i}`)
  const target = native('s', keys)
  let journal = addNativeReplies({}, keys)
  io.rpc.mockImplementation(async () => {
    keys.push('later')
    journal = addNativeReplies(journal, ['later'])
    return { data: [], error: null }
  })
  io.write.mockImplementation(async target => { if (target.kind === 'native') journal = seeNativeReplies(journal, target.itemIds) })
  expect(await markChatsReadAndRefresh({ chats: [], refresh, nativeReads: [target] })).toEqual({ failedChats: 0 })
  expect(io.write.mock.calls.map(([target]) => target.kind === 'native' && target.itemIds.length)).toEqual([500, 500, 1])
  expect(unreadNativeMessages(journal)).toEqual(['later'])
})

it('keeps successful batches, stops the failed conversation and continues other hosts, counting a shared DM only once', async () => {
  io.rpc.mockResolvedValue({ data: [{ chat_id: 'dm', message_seq: 1 }], error: null })
  io.write.mockImplementation(async target => {
    if (target.kind !== 'native' || target.conversationId === 's' && target.itemIds[0] === '500') throw new Error('offline')
  })
  const result = await markChatsReadAndRefresh({ chats: [chat({ id: 'dm', next_message_seq: 2 })], refresh,
    nativeReads: [native('s', Array.from({ length: 1001 }, (_, i) => String(i)), 'dm'), { ...native('other'), deviceId: 'other-host' }] })
  expect(result).toMatchObject({ failedChats: 1, error: expect.any(Error) })
  expect(io.write.mock.calls.map(([target]) => target.kind === 'native' ? [target.deviceId, target.conversationId, target.itemIds[0]] : target.kind)).toEqual([
    'main', ['host', 's', '0'], ['other-host', 'other', 'old'], ['host', 's', '500'],
  ])
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ acceptEmpty: true })
})

it('preserves a manual unread click while the bulk projection is pending, including its native branch', async () => {
  const projection = gate()
  io.rpc.mockImplementation(async () => { await projection.promise; return { data: [{ chat_id: 'dm', message_seq: 1 }], error: null } })
  const pending = markChatsReadAndRefresh({ chats: [chat({ id: 'dm', next_message_seq: 2 })], refresh, nativeReads: [native('s', ['old'], 'dm'), native('other')] })
  await manual()
  projection.resolve()
  await pending
  expect(io.write).toHaveBeenCalledExactlyOnceWith({ kind: 'native', deviceId: 'host', conversationId: 'other', itemIds: ['old'] })
})

it('orders a later manual unread after an in-flight batch and cancels the remaining batches', async () => {
  const started = gate(), finish = gate()
  const order: string[] = []
  io.write.mockImplementation(async () => { started.resolve(); await finish.promise; order.push('read') })
  io.manual.mockImplementation(async () => { order.push('unread') })
  const pending = markChatsReadAndRefresh({ chats: [], refresh, nativeReads: [native('s', Array.from({ length: 501 }, (_, i) => String(i)), 'dm')] })
  await vi.waitFor(() => expect(io.write).toHaveBeenCalled())
  await started.promise
  const marking = manual()
  expect(io.manual).not.toHaveBeenCalled()
  finish.resolve()
  await Promise.all([pending, marking])
  expect(order).toEqual(['read', 'unread'])
  expect(io.write).toHaveBeenCalledTimes(1)
})

it('allows a later explicit read to follow a pending manual unread in click order', async () => {
  const finish = gate(), started = gate()
  const order: string[] = []
  io.manual.mockImplementation(async () => { started.resolve(); await finish.promise; order.push('unread') })
  io.write.mockImplementation(async () => { order.push('read') })
  const marking = manual()
  await started.promise
  const pending = markChatsReadAndRefresh({ chats: [], refresh, nativeReads: [native('s', ['old'], 'dm')] })
  expect(io.write).not.toHaveBeenCalled()
  finish.resolve()
  await Promise.all([marking, pending])
  expect(order).toEqual(['unread', 'read'])
})

it('preserves a new server manual unread even if the mutable chat row also advances during the projection', async () => {
  const selected = chat({ id: 'dm', next_message_seq: 2, is_marked_unread: false })
  io.rpc.mockImplementation(async () => {
    selected.is_marked_unread = true
    return { data: [{ chat_id: 'dm', message_seq: 1, is_marked_unread: true }], error: null }
  })
  await markChatsReadAndRefresh({ chats: [selected], refresh, nativeReads: [native('s', ['old'], 'dm')] })
  expect(io.write).not.toHaveBeenCalled()
})
