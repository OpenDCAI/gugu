import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatOutbox } from '../../../../apps/desktop/src/store/chatOutbox'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

function record(id: string, chatId = 'A', dependsOn?: string): OutboxRecord {
  return { clientMessageId: id, chatId, senderUserId: 'user', dependsOn,
    payload: { content: id, contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function fixture(saved = new Map<string, OutboxRecord>(), beforeSave: (record: OutboxRecord) => Promise<void> = async () => {}) {
  const send = vi.fn(async (_row: OutboxRecord): Promise<void> => {})
  const outbox = createChatOutbox({ load: async () => [...saved.values()], save: async r => { await beforeSave(r); saved.set(r.clientMessageId, structuredClone(r)) },
    remove: async id => { saved.delete(id) }, deliver: send, onSent: vi.fn(), onDiscarded: vi.fn(), onState: vi.fn(), backoffMs: [] })
  return { saved, send, outbox }
}
async function flush() { await vi.advanceTimersByTimeAsync(0) }
afterEach(() => { vi.useRealTimers() })

describe('durable source dependencies in the chat outbox', () => {
  it('uploads do not occupy a lane, and multiple forwards wait for the same source', async () => {
    vi.useFakeTimers()
    const { outbox, send } = fixture()
    await outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await outbox.enqueue(record('forward-B', 'B', 'image'))
    await outbox.enqueue(record('forward-C', 'C', 'image'))
    await outbox.enqueue(record('text', 'A'))
    await flush()
    expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['text'])
    await outbox.commitUpload({ ...record('image'), operation: { kind: 'attachment', commit: { staging_key: 'staging/image', message_id: 'image', chat_id: 'A', sender_user_id: 'user', file_name: 'photo.png' } } })
    await flush()
    expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['text', 'image', 'forward-B', 'forward-C'])
    outbox.dispose()
  })
  it('an uploading source and a dependent topic in the same lane cannot deadlock', async () => {
    vi.useFakeTimers()
    const { outbox, send } = fixture()
    await outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await outbox.enqueue(record('topic', 'A', 'image'))
    await flush()
    expect(send).not.toHaveBeenCalled()
    await outbox.commitUpload(record('image'))
    await flush()
    expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['image', 'topic'])
    outbox.dispose()
  })
  it('source failure immediately fails forwarding and releases later destination text', async () => {
    vi.useFakeTimers()
    const { outbox, saved, send } = fixture()
    await outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await outbox.enqueue(record('forward', 'B', 'image'))
    await outbox.enqueue(record('later', 'B'))
    await outbox.failUpload('image', new Error('upload refused'))
    await flush()
    expect(saved.get('forward')).toMatchObject({ state: 'failed', attempts: 0, lastError: 'upload refused' })
    expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['later'])
    outbox.dispose()
  })
  it('retrying forwarding waits while the source itself retries, then delivers once', async () => {
    vi.useFakeTimers()
    const { outbox, saved, send } = fixture()
    let rejectSource = true
    let finish!: () => void
    send.mockImplementation(async r => {
      if (r.clientMessageId !== 'source') return
      if (rejectSource) throw new Error('offline')
      await new Promise<void>(resolve => { finish = resolve })
    })
    await outbox.enqueue(record('source'))
    await flush()
    await outbox.enqueue(record('forward', 'B', 'source'))
    await flush()
    expect(saved.get('forward')?.state).toBe('failed')
    rejectSource = false
    await outbox.retry('source')
    await outbox.retry('forward')
    await flush()
    expect(saved.get('forward')?.state).toBe('sending')
    finish()
    await flush()
    expect(send.mock.calls.filter(([r]) => r.clientMessageId === 'forward')).toHaveLength(1)
    outbox.dispose()
  })
  it('discard is durable: a restored dependent cannot be retried as if its source arrived', async () => {
    vi.useFakeTimers()
    const { outbox, saved } = fixture()
    await outbox.stageUpload({ ...record('source'), operation: { kind: 'upload' } })
    await outbox.enqueue(record('forward', 'B', 'source'))
    await outbox.discard('source')
    await flush()
    expect(saved.get('forward')).toMatchObject({ state: 'failed', dependencyDiscarded: true })
    outbox.dispose()
    const restored = fixture(saved)
    await restored.outbox.restore()
    await restored.outbox.retryAllFailed()
    await restored.outbox.retry('forward')
    await flush()
    expect(restored.send).not.toHaveBeenCalled()
    restored.outbox.dispose()
  })
  it('reload fails a byte-less upload and its dependent, without blocking the destination', async () => {
    vi.useFakeTimers()
    const saved = new Map<string, OutboxRecord>([
      ['upload', { ...record('upload'), operation: { kind: 'upload' }, state: 'uploading' }],
      ['forward', record('forward', 'B', 'upload')], ['text', record('text', 'B')],
    ])
    const { outbox, send } = fixture(saved)
    await outbox.restore()
    await flush()
    expect(saved.get('upload')?.state).toBe('failed')
    expect(saved.get('forward')?.state).toBe('failed')
    expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['text'])
    outbox.dispose()
  })
})

it('discarding a waiting forward immediately releases its destination lane', async () => {
  vi.useFakeTimers()
  const { outbox, send } = fixture()
  await outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await outbox.enqueue(record('forward', 'B', 'upload'))
  await outbox.enqueue(record('text', 'B'))
  await flush()
  await outbox.discard('forward')
  await flush()
  expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['text'])
  outbox.dispose()
})
it('a same-lane upload failure releases its dependent and the later text', async () => {
  vi.useFakeTimers()
  const { outbox, send, saved } = fixture()
  await outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await outbox.enqueue(record('topic', 'A', 'upload'))
  await outbox.enqueue(record('text', 'A'))
  await flush()
  await outbox.failUpload('upload', new Error('upload refused'))
  await flush()
  expect(saved.get('topic')?.state).toBe('failed')
  expect(send.mock.calls.map(([r]) => r.clientMessageId)).toEqual(['text'])
  outbox.dispose()
})

it('discard during byte upload cannot be undone by its eventual ready commit', async () => {
  vi.useFakeTimers()
  const { outbox, send, saved } = fixture()
  await outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await outbox.discard('upload')
  expect(await outbox.commitUpload(record('upload'))).toBe(false)
  await flush()
  expect(saved.has('upload')).toBe(false)
  expect(send).not.toHaveBeenCalled()
  outbox.dispose()
})

it('discard wins over upload completion while dependent failure is being persisted', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { outbox, send } = fixture(new Map(), async r => {
    if (r.clientMessageId === 'forward' && r.dependencyDiscarded) await gate
  })
  await outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await outbox.enqueue(record('forward', 'B', 'upload'))
  await flush()
  const discard = outbox.discard('upload')
  expect(await outbox.commitUpload(record('upload'))).toBe(false)
  release()
  await discard
  await flush()
  expect(send).not.toHaveBeenCalled()
  outbox.dispose()
})
