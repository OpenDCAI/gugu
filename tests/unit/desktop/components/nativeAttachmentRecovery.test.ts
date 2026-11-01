// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { settleAttachmentSend } from '../../../../apps/desktop/src/lib/attachmentSendRecovery'
import { attachmentSendTiming } from '../../../../apps/desktop/src/lib/attachmentSendTiming'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const mocks = vi.hoisted(() => ({ publish: vi.fn(), read: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ commitPreparedChatAttachment: mocks.publish }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.read } }))
const row = { id: 'native', chat_id: 'chat', sender_user_id: 'user', seq: 42, content_type: 'attachment' } as MessageItem
function arrange() {
  vi.useFakeTimers()
  mocks.publish.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.read.mockReset().mockResolvedValue(null)
  return { endpoint: { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' },
    prepared: { local: new File(['bytes'], 'large.txt') },
    commit: { message_id: 'native', chat_id: 'chat', sender_user_id: 'user', file_name: 'large.txt', to_user_ids: [] },
    timing: attachmentSendTiming('native', 'chat') }
}
afterEach(() => { vi.useRealTimers() })
it('does not mistake a slow native publication for the ordinary 15-second delivery timeout', async () => {
  const args = arrange()
  let finish!: (value: unknown) => void
  mocks.publish.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let settled = false
  const done = settleAttachmentSend(args).finally(() => { settled = true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(settled).toBe(false)
  expect(mocks.publish).toHaveBeenCalledOnce()
  finish(row)
  await expect(done).resolves.toMatchObject({ id: 'native', seq: 42 })
})
it.each(['readback', 'realtime'])('reconciles slow native publication through %s without republishing', async mode => {
  const args = arrange()
  let receive!: (message: MessageItem) => void
  const done = settleAttachmentSend({ ...args, observeMessage: (_id, callback) => { receive = callback; return vi.fn() } })
  await vi.advanceTimersByTimeAsync(25_000)
  if (mode === 'readback') mocks.read.mockResolvedValue(row)
  else receive(row)
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(done).resolves.toMatchObject({ id: 'native', seq: 42 })
  expect(mocks.publish).toHaveBeenCalledOnce()
})
it('accepts the same native receipt after its observation limit', async () => {
  const args = arrange()
  let finish!: (value: unknown) => void
  mocks.publish.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const onLateMessage = vi.fn()
  const done = settleAttachmentSend({ ...args, onLateMessage })
  await vi.advanceTimersByTimeAsync(600_000)
  await expect(done).resolves.toBeNull()
  finish(row)
  await vi.advanceTimersByTimeAsync(0)
  expect(onLateMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'native', seq: 42 }))
  expect(mocks.publish).toHaveBeenCalledOnce()
})
