import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { buildSessionDirectEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { openSessionInputStorage, SessionInputOutbox, sessionInputBubbles, withSessionInputDeadline, type HostPendingRow, type SessionInput } from '../../../../apps/desktop/src/lib/sessionInputOutbox'

describe('native session input persistence', () => {
  it('preserves stored runtime attachment references and does not block the following input', async () => {
    const storage = await openSessionInputStorage(new IDBFactory())
    const received: SessionInput[] = []
    const legacy: SessionInput = { id: 'older-input', accountId: 'owner', deviceId: 'host', sessionId: 'agent', text: 'read the image', createdAt: 1,
      attachments: [{ type: 'attachment', id: 'old-image', mimeType: 'image/png' }] }
    await storage.put(legacy)
    const queue = new SessionInputOutbox('owner', storage, async input => { received.push(input) }, () => true)
    await queue.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'following input' })
    await queue.flush()
    expect(received.map(input => input.text)).toEqual(['read the image', 'following input'])
    expect(received[0].attachments).toEqual(legacy.attachments)
    expect(await queue.list()).toEqual([])
  })
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
  const files = [{ itemId: 'image-item', version: 1, name: 'image.png', mimeType: 'image/png', sizeBytes: 4 }]
  const input = await queue.enqueue({ deviceId: 'host', sessionId: 'agent', text: 'look at this', files })
  await queue.flush()
  const received: SessionInput[] = []
  const restored = new SessionInputOutbox('owner', await openSessionInputStorage(factory), async input => { received.push(input) }, () => true)
  await restored.flush()
  expect(received).toEqual([expect.objectContaining({ id: input.id, text: 'look at this', files })])
  expect(await restored.list()).toEqual([])
})

it('stores a missing acknowledgement as its failure code and keeps a host refusal in the host words', async () => {
  const storage = await openSessionInputStorage(new IDBFactory())
  let send = (_input: SessionInput) => withSessionInputDeadline(new Promise<void>(() => {}), 1)
  const outbox = new SessionInputOutbox('owner', storage, input => send(input), () => true)
  const input = await outbox.enqueue({ deviceId: null, sessionId: 'agent', text: 'silent host' })
  await outbox.flush()
  expect((await outbox.list())[0]).toMatchObject({ id: input.id, failure: { code: 'no-acknowledgement' } })
  send = async () => { throw new Error('Provider login expired') }
  await outbox.flush()
  expect((await outbox.list())[0]).toMatchObject({ id: input.id, failure: { code: 'send-failed', message: 'Provider login expired' } })
})

describe('a bubble reads the one custody owner of its messageId', () => {
  const sender = (id: string, createdAt: number, extra: Partial<SessionInput> = {}): SessionInput =>
    ({ id, accountId: 'owner', deviceId: null, sessionId: 'agent', text: `sender ${id}`, createdAt, ...extra })
  const host = (seq: number, messageId: string, state: HostPendingRow['state'], over: Partial<HostPendingRow> = {}): HostPendingRow =>
    ({ seq, messageId, preview: `host ${messageId}`.slice(0, 4), text: `host ${messageId}`, kind: 'session-direct', sentAt: 0, state, failure: null, ...over })

  it('a row behind a person\'s stop says so: it goes with their next message, it is not on its way', () => {
    expect(sessionInputBubbles([], [host(1, 'q', 'queued')], 'user-stop')[0]?.state).toBe('stopped')
    expect(sessionInputBubbles([], [host(1, 'q', 'queued')], 'sign-out')[0]?.state).toBe('held')
  })

  it('sender row until the host row exists, the host row until accepted, then nothing (the transcript has it)', () => {
    expect(sessionInputBubbles([sender('m', 1)], [], null)).toEqual([{ id: 'm', text: 'sender m', state: 'sending' }])
    // A queued message from another task is a delivery: its sender and body, the way the transcript reads it, never the envelope.
    const envelope = buildSessionDirectEnvelope({ senderSessionId: 'other-task', senderTitle: 'Builder', messageId: 'd', content: 'the run finished', at: '2026-11-01 08:00 北京时间' })
    const [delivered] = sessionInputBubbles([], [{ ...host(1, 'd', 'queued'), text: envelope, kind: 'session-direct' }], 'start-failed')
    expect(delivered).toMatchObject({ id: 'd', text: 'the run finished', from: 'Builder', state: 'held' })
    expect(delivered!.text).not.toContain('<gugu_delivery')
    expect(sessionInputBubbles([sender('m', 1)], [host(1, 'm', 'dispatching')], null)).toEqual([{ id: 'm', text: 'host m', state: 'sending' }])
    expect(sessionInputBubbles([sender('m', 1)], [host(1, 'm', 'accepted')], null)).toEqual([])
    expect(sessionInputBubbles([], [host(1, 'm', 'accepted')], null)).toEqual([])
  })

  it('a queued inbox batch is a pending row like any other (one projection); a failed host row says the host\'s reason', () => {
    expect(sessionInputBubbles([], [host(1, 'mail', 'queued', { kind: 'inbox-batch' })], null)).toEqual([{ id: 'mail', text: 'host mail', state: 'sending' }])
    expect(sessionInputBubbles([], [host(1, 'f', 'failed', { failure: 'The session stopped before dispatch' })], null))
      .toEqual([{ id: 'f', text: 'host f', state: 'failed', failure: null, hostReason: 'The session stopped before dispatch' }])
  })

  it('names each state: queued sending, failed with the sender reason or the host failure, unknown not resent', () => {
    expect(sessionInputBubbles(
      [sender('b', 2, { failure: { code: 'host-offline' } }), sender('a', 1)],
      [host(3, 'q', 'queued'), host(1, 'f', 'failed'), host(2, 'u', 'unknown')],
      null,
    ).map(bubble => [bubble.id, bubble.state, bubble.state === 'failed' ? bubble.failure : null])).toEqual([
      ['f', 'failed', null], ['u', 'unknown', null], ['q', 'sending', null],
      ['a', 'sending', null], ['b', 'failed', { code: 'host-offline' }],
    ])
  })

  it('a host row draws its full text, never the summary preview', () => {
    const long = 'x'.repeat(400)
    expect(sessionInputBubbles([], [host(1, 'm', 'queued', { text: long, preview: long.slice(0, 160) })], null)[0]?.text).toBe(long)
  })

  it('while the session is failed its queued host rows are held for a retry, not sending; sender rows still send', () => {
    expect(sessionInputBubbles([sender('s', 1)], [host(1, 'q', 'queued'), host(2, 'd', 'dispatching')], 'start-failed')
      .map(bubble => [bubble.id, bubble.state])).toEqual([['q', 'held'], ['d', 'held'], ['s', 'sending']])
  })
})
