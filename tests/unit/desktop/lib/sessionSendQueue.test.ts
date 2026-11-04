import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openSessionInputStorage, SessionInputOutbox } from '@/lib/sessionInputOutbox'

const target = { deviceId: 'remote', sessionId: 'session', queued: true, sendQueue: { order: 0 }, text: '好' }

describe('composer-owned durable send queue', () => {
  it('classifies two same-frame composer submissions under the persistence lock', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const sent: string[] = []
    const queue = new SessionInputOutbox('owner', storage, async input => { sent.push(input.id) }, () => true)
    const submit = { deviceId: 'remote', sessionId: 'session', text: '好', queued: false, composer: true as const }
    const [first, second] = await Promise.all([queue.enqueue(submit), queue.enqueue(submit)])
    expect(first.sendQueue).toBeUndefined()
    expect(second.sendQueue).toMatchObject({ afterInputId: first.id })
    await queue.flush()
    expect(sent).toEqual([first.id])
  })
  it('does not send a known-busy input on enqueue, timer flush, reconnect or manual retry', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const sent: string[] = []
    const send = async (input: { id: string }) => { sent.push(input.id) }
    const queue = new SessionInputOutbox('owner', storage, send, () => true)
    const input = await queue.enqueue(target)
    await queue.flush()
    await queue.flush(true)
    const restarted = new SessionInputOutbox('owner', storage, send, () => true)
    await restarted.flush()
    expect(sent).toEqual([])
    expect(await restarted.list()).toMatchObject([{ id: input.id, text: '好', sendQueue: expect.any(Object) }])
  })

  it('edits, deletes and reorders the actual persistent queue before any transport request', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const sent: string[] = []
    const queue = new SessionInputOutbox('owner', storage, async input => { sent.push(input.text) }, () => true)
    const a = await queue.enqueue(target)
    const b = await queue.enqueue(target)
    const c = await queue.enqueue(target)
    expect(a.id).not.toBe(b.id)
    await queue.changeQueued(b.id, { text: 'edited', edit: { draftText: 'editing', originalDraftText: 'my draft' } })
    await queue.reorderQueued('session', [c.id, b.id, a.id])
    expect(await queue.changeQueued(a.id, 'delete')).toBe(true)
    await queue.flush()
    expect(sent).toEqual([])
    const rows = (await queue.list()).sort((x, y) => x.sendQueue!.order - y.sendQueue!.order)
    expect(rows.map(row => row.id)).toEqual([c.id, b.id])
    expect(rows[1]).toMatchObject({ text: 'edited', sendQueue: { edit: { draftText: 'editing', originalDraftText: 'my draft' } } })
  })

  it('holds the editing entry, then releases exactly one and waits for its own completed ID', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const sent: string[] = []
    const queue = new SessionInputOutbox('owner', storage, async input => { sent.push(input.id) }, () => true)
    const a = await queue.enqueue(target)
    const b = await queue.enqueue(target)
    await queue.changeQueued(a.id, { text: '好', edit: { draftText: 'next', originalDraftText: 'draft' } })
    expect(await queue.releaseQueued('session', {}, new Set())).toBeNull()
    await queue.changeQueued(a.id, { text: 'next', edit: null })
    expect(await queue.releaseQueued('session', { afterTurnId: 'old-turn', baseline: ['old'] }, new Set())).toMatchObject({ id: a.id, queued: false, afterTurnId: 'old-turn' })
    await queue.flush()
    expect(sent).toEqual([a.id])
    expect(await queue.releaseQueued('session', {}, new Set(['another-message-id']))).toBeNull()
    const restarted = new SessionInputOutbox('owner', storage, async input => { sent.push(input.id) }, () => true)
    expect(await restarted.releaseQueued('session', {}, new Set())).toBeNull()
    expect(await restarted.releaseQueued('session', {}, new Set([a.id]))).toMatchObject({ id: b.id, queued: false })
    await restarted.flush()
    expect(sent).toEqual([a.id, b.id])
  })

  it('does not bypass an ordinary offline input while releasing its queued follower', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const queue = new SessionInputOutbox('owner', storage, async () => { throw new Error('offline') }, () => true)
    await queue.enqueue({ deviceId: 'remote', sessionId: 'session', text: 'first', queued: false })
    await queue.enqueue(target)
    await queue.flush()
    expect(await queue.releaseQueued('session', {}, new Set())).toBeNull()
    expect(await queue.list()).toHaveLength(2)
  })

  it('serializes removal before release so a deleted message never reaches transport', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const sent: string[] = []
    const queue = new SessionInputOutbox('owner', storage, async input => { sent.push(input.id) }, () => true)
    const input = await queue.enqueue(target)
    const removed = queue.changeQueued(input.id, 'delete')
    const released = queue.releaseQueued('session', {}, new Set())
    expect(await removed).toBe(true)
    expect(await released).toBeNull()
    await queue.flush()
    expect(sent).toEqual([])
  })
})
