import { afterEach, expect, it, vi } from 'vitest'
import { authBoundedFetch } from '../../../../apps/desktop/src/lib/authBoundedFetch'
import { chatSendTimings, finishChatSendTiming } from '../../../../apps/desktop/src/lib/chatSendTiming'
import { createChatOutbox } from '../../../../apps/desktop/src/store/chatOutbox'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => logger }))
afterEach(() => { chatSendTimings.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('emits one content-free record only after the authoritative response and durable ack', async () => {
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
  const record: OutboxRecord = {
    clientMessageId: 'client-a', chatId: 'chat-a', senderUserId: 'sender-a',
    payload: { content: 'PRIVATE BODY', contentType: 'text', toUserIds: null, replyToMessageId: null,
      threadRootId: null, isThreadRoot: false, isWhisper: false },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: '', updatedAt: '',
  }
  let releaseAck!: () => void
  let enteredAck!: () => void
  const ackEntered = new Promise<void>((resolve) => { enteredAck = resolve })
  const ackReady = new Promise<void>((resolve) => { releaseAck = resolve })
  chatSendTimings.set(record.clientMessageId, { submit: now })
  const outbox = createChatOutbox({
    load: async () => [], save: async (row) => { if (row.state === 'pending') now = 1020 },
    remove: async () => {}, prepare: async (row) => { now = 1050; return row },
    deliver: async () => {
      await authBoundedFetch('https://db.example/rest/v1/rpc/send_message_idempotent', {
        method: 'POST', body: JSON.stringify({ p_message_id: record.clientMessageId, p_content: record.payload.content }),
      })
      now = 1250
      return { id: record.clientMessageId }
    },
    ack: async () => { enteredAck(); await ackReady; now = 1260 },
    onState: () => {}, onSent: () => {}, onDiscarded: () => {}, setTimeout: () => 0,
  })
  await outbox.enqueue(record)
  await ackEntered
  expect(logger.info).not.toHaveBeenCalled()
  releaseAck()
  await outbox.delivered(record.clientMessageId)
  expect(logger.info.mock.calls).toEqual([[{
    clientId: 'client-a', submitToEnqueueMs: 20, enqueueToHttpMs: 30,
    httpToResponseMs: 200, responseToAckMs: 10, totalMs: 260,
  }, 'message send timing']])
  expect(logger.warn).not.toHaveBeenCalled()
  expect(chatSendTimings.has(record.clientMessageId)).toBe(false)
  finishChatSendTiming(record.clientMessageId, true)
  expect(logger.info).toHaveBeenCalledTimes(1)
  outbox.dispose()
})

it('uses the two-second threshold on the injected monotonic clock, with absent stages left null', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(2000)
  chatSendTimings.set('at-threshold', { submit: 0 })
  finishChatSendTiming('at-threshold')
  expect(logger.info).toHaveBeenCalledWith({ clientId: 'at-threshold', submitToEnqueueMs: null,
    enqueueToHttpMs: null, httpToResponseMs: null, responseToAckMs: null, totalMs: 2000 }, 'message send timing')
  clock.mockReturnValue(2001)
  chatSendTimings.set('slow', { submit: 0 })
  finishChatSendTiming('slow')
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'slow', totalMs: 2001 }), 'message send timing')
  expect(chatSendTimings.size).toBe(0)
})

it('keeps the first HTTP attempt timestamp and never changes malformed request validation', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10)
  const fetcher = vi.fn(async () => new Response('[]'))
  vi.stubGlobal('fetch', fetcher)
  chatSendTimings.set('retry', { submit: 0 })
  const url = 'https://db.example/rest/v1/rpc/send_message_idempotent'
  const options = { method: 'POST', body: '{"p_message_id":"retry"}' }
  await authBoundedFetch(url, options)
  clock.mockReturnValue(20)
  await authBoundedFetch(url, options)
  expect(chatSendTimings.get('retry')?.http).toBe(10)
  expect((await authBoundedFetch(url, { method: 'POST', body: 'malformed' })).status).toBe(200)
  expect(fetcher).toHaveBeenLastCalledWith(url, expect.objectContaining({ body: 'malformed' }))
})
