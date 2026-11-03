import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatOutbox } from '../../../../apps/desktop/src/store/chatOutbox'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

function record(id: string, chatId = 'A', dependsOn?: string): OutboxRecord {
  return { clientMessageId: id, chatId, senderUserId: 'user', dependsOn,
    payload: { content: id, contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function fixture(saved = new Map<string, OutboxRecord>(), beforeSave: (record: OutboxRecord) => Promise<void> = async () => {}, ack?: (record: OutboxRecord) => Promise<void>) {
  const send = vi.fn(async (_row: OutboxRecord): Promise<void> => {})
  const outbox = createChatOutbox({ load: async () => [...saved.values()], save: async r => { await beforeSave(r); saved.set(r.clientMessageId, structuredClone(r)) },
    ...(ack ? { ack: async (row: OutboxRecord) => { await ack(row); saved.delete(row.clientMessageId) } } : {}),
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
    expect(saved.get('forward')).toMatchObject({ state: 'failed', attempts: 0 })
    expect(saved.get('forward')?.lastError).not.toContain('upload refused')
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
    expect(saved.get('forward')?.state).toBe('pending')
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

describe('creation order prevents lane/dependency cycles', () => {
  it('commits an earlier upload before a cross-lane forwarding chain waiting back on it', async () => {
    vi.useFakeTimers()
    const { outbox, send, saved } = fixture()
    await outbox.stageUpload({ ...record('u', 'A'), operation: { kind: 'upload' } })
    await outbox.enqueue(record('f_b', 'B', 'u'))
    await outbox.enqueue(record('b2', 'B'))
    await outbox.enqueue(record('f_a', 'A', 'b2'))
    await flush()
    await outbox.commitUpload(record('u', 'A'))
    await flush()
    expect(send.mock.calls.map(([row]) => row.clientMessageId)).toEqual(['u', 'f_b', 'b2', 'f_a'])
    expect([...saved.values()]).toEqual([])
    outbox.dispose()
  })
  it('does not deliver a dependent while discard persistence is suspended', async () => {
    vi.useFakeTimers()
    let releaseSave!: () => void, releaseSend!: () => void
    const saving = new Promise<void>(resolve => { releaseSave = resolve })
    const sending = new Promise<void>(resolve => { releaseSend = resolve })
    const f = fixture(new Map(), async row => { if (row.clientMessageId === 'dep' && row.state === 'failed') await saving })
    f.send.mockImplementation(async row => { if (row.clientMessageId === 't0' || row.clientMessageId === 'source') await sending })
    await f.outbox.enqueue(record('source', 'S'))
    await f.outbox.enqueue(record('t0', 'T'))
    await f.outbox.enqueue(record('dep', 'T', 'source'))
    await flush()
    const discarding = f.outbox.discard('source')
    releaseSend()
    await flush()
    releaseSave()
    await discarding
    await flush()
    expect(f.send.mock.calls.map(([row]) => row.clientMessageId)).not.toContain('dep')
    expect(f.saved.get('dep')).toMatchObject({ state: 'failed', dependencyDiscarded: true })
    f.outbox.dispose()
  })
  it('terminates seeded interleavings of lanes, uploads, forwarding, failure, discard and restart', async () => {
    vi.useFakeTimers()
    for (let seed = 1; seed <= 30; seed++) {
      let randomState = seed
      const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
      const ack = async (row: OutboxRecord) => { if (row.clientMessageId === 'ack-final') throw new Error('ack failed') }
      let f = fixture(new Map(), async () => {}, ack)
      const configure = () => f.send.mockImplementation(async row => { if (Number(row.clientMessageId.slice(1)) % 7 === 0) throw new Error('offline') })
      configure()
      const ids: string[] = []
      for (let n = 0; n < 24; n++) {
        const id = `m${n}`, lane = String(random() % 3)
        const dependsOn = ids.length && random() % 3 === 0 ? ids[random() % ids.length] : undefined
        const row = record(id, lane, dependsOn)
        if (random() % 3 === 0) await f.outbox.stageUpload({ ...row, operation: { kind: 'upload' } })
        else await f.outbox.enqueue(row)
        ids.push(id)
        if (random() % 4 === 0) await f.outbox.discard(ids[random() % ids.length])
        if (random() % 5 === 0) {
          const uploading = [...f.saved.values()].find(r => r.state === 'uploading')
          if (uploading) await f.outbox.commitUpload({ ...uploading, operation: undefined })
        }
        await flush()
        if (n === 12) { f.outbox.dispose(); f = fixture(f.saved, async () => {}, ack); configure(); await f.outbox.restore(); await flush() }
      }
      for (const row of [...f.saved.values()]) if (row.state === 'uploading') await f.outbox.commitUpload({ ...row, operation: undefined })
      await flush()
      expect([...f.saved.values()].filter(row => row.state !== 'failed'), `seed ${seed}`).toEqual([])
      // No subsequent enqueue may conceal a missing failure-settlement kick.
      await f.outbox.stageUpload({ ...record('last-upload', 'A'), operation: { kind: 'upload' } })
      await f.outbox.enqueue(record('last-forward', 'B', 'last-upload'))
      await f.outbox.enqueue(record('last-chain', 'C', 'last-forward'))
      await flush()
      await f.outbox.failUpload('last-upload', new Error('offline'))
      await flush()
      expect([...f.saved.values()].filter(row => row.state !== 'failed'), `upload-last seed ${seed}`).toEqual([])
      await f.outbox.enqueue(record('ack-final', 'A'))
      await f.outbox.enqueue(record('ack-forward', 'B', 'ack-final'))
      await f.outbox.enqueue(record('ack-chain', 'C', 'ack-forward'))
      await flush()
      expect([...f.saved.values()].filter(row => row.state !== 'failed'), `ack-last seed ${seed}`).toEqual([])
      f.outbox.dispose()
    }
  })
})

it('propagates the last upload failure through multiple lanes without another external kick', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.outbox.stageUpload({ ...record('s', 'A'), operation: { kind: 'upload' } })
  await f.outbox.enqueue(record('f1', 'B', 's'))
  await f.outbox.enqueue(record('f2', 'C', 'f1'))
  await f.outbox.enqueue(record('later', 'C'))
  await flush()
  await f.outbox.failUpload('s', new Error('refused'))
  await flush()
  expect(f.send.mock.calls.map(([row]) => row.clientMessageId)).toEqual(['later'])
  expect([...f.saved.values()].map(row => row.state)).toEqual(['failed', 'failed', 'failed'])
  f.outbox.dispose()
})
it('propagates the last durable ack failure to a dependent without another external kick', async () => {
  vi.useFakeTimers()
  const saved = new Map<string, OutboxRecord>()
  const send = vi.fn(async () => {})
  const outbox = createChatOutbox({ load: async () => [], save: async row => { saved.set(row.clientMessageId, structuredClone(row)) },
    remove: async id => { saved.delete(id) }, ack: async () => { throw new Error('local write failed') }, deliver: send,
    onSent: vi.fn(), onDiscarded: vi.fn(), onState: vi.fn(), backoffMs: [] })
  await outbox.enqueue(record('s', 'A'))
  await outbox.enqueue(record('f', 'B', 's'))
  await flush()
  expect(send).toHaveBeenCalledOnce()
  expect([...saved.values()].map(row => row.state)).toEqual(['failed', 'failed'])
  outbox.dispose()
})
it('native publication remains outside the lane and is confirmed through the same durable ack', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.outbox.stageUpload({ ...record('native'), operation: { kind: 'upload' } })
  await f.outbox.commitUpload({ ...record('native'), operation: { kind: 'nativeAttachment', commit: { message_id: 'native', chat_id: 'A', sender_user_id: 'user', file_name: 'large.txt', to_user_ids: [] } } })
  await f.outbox.enqueue(record('text'))
  await f.outbox.enqueue(record('forward', 'B', 'native'))
  await flush()
  expect(f.send.mock.calls.map(([row]) => row.clientMessageId)).toEqual(['text'])
  expect(f.saved.get('native')?.state).toBe('uploading')
  await f.outbox.confirm('native', undefined)
  await flush()
  expect(f.send.mock.calls.map(([row]) => row.clientMessageId)).toEqual(['text', 'forward'])
  expect([...f.saved.values()]).toEqual([])
  f.outbox.dispose()
})
