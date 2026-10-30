import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openSessionInputStorage, SessionInputOutbox, type SessionInput } from '../../../../apps/desktop/src/lib/sessionInputOutbox'

describe('native session input persistence', () => {
  it('survives an offline restart and delivers in order automatically with the same identities', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    let online = false
    const received: SessionInput[] = []
    const send = async (input: SessionInput) => { if (!online) throw new Error('offline'); received.push(input) }
    const first = new SessionInputOutbox('owner', storage, send, () => true)
    const a = await first.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'first' })
    const b = await first.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'second' })
    await first.flush()
    expect(await first.list()).toHaveLength(2)
    online = true
    const restarted = new SessionInputOutbox('owner', storage, send, () => true)
    await restarted.flush()
    expect(received.map(input => [input.id, input.text])).toEqual([[a.id, 'first'], [b.id, 'second']])
    expect(await restarted.list()).toEqual([])
  })

  it('replays the same id after an acknowledgement is lost, without a second native turn', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const host = new Map<string, string>()
    let lost = true
    const queue = new SessionInputOutbox('owner', storage, async input => {
      host.set(input.id, input.text)
      if (lost) throw new Error('reply lost')
    }, () => true)
    const input = await queue.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'raw user input' })
    await queue.flush()
    lost = false
    await queue.flush()
    expect([...host]).toEqual([[input.id, 'raw user input']])
    expect(await queue.list()).toEqual([])
  })

  it('never drains another account after logout', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    let current = true
    const owner = new SessionInputOutbox('owner', storage, async () => { throw new Error('offline') }, () => current)
    await owner.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'private' })
    await owner.flush()
    current = false
    await owner.flush()
    expect(await new SessionInputOutbox('other', storage, async () => {}, () => true).list()).toEqual([])
    expect(await owner.list()).toHaveLength(1)
  })
})

it('keeps an image and its caption in one durable request across a reopened database', async () => {
  const factory = new IDBFactory()
  const storage = await openSessionInputStorage(factory)
  const queue = new SessionInputOutbox('owner', storage, async () => { throw new Error('offline') }, () => true)
  const attachments = [{ type: 'attachment' as const, id: 'image-ref', mimeType: 'image/png' as const, name: 'image.png' }]
  const input = await queue.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'look at this', attachments })
  await queue.flush()
  const received: SessionInput[] = []
  const restored = new SessionInputOutbox('owner', await openSessionInputStorage(factory), async input => { received.push(input) }, () => true)
  await restored.flush()
  expect(received).toEqual([expect.objectContaining({ id: input.id, text: 'look at this', attachments })])
  expect(await restored.list()).toEqual([])
})
