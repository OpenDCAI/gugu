import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { ProjectionSignals } from './signaling.mjs'
import { openMediaProcess } from './host.mjs'

const context = Object.freeze({ ownerId: 'owner', deviceId: 'viewer-device', appId: 'app-a', sessionId: 'task-a', pageId: 'page-a', epoch: 'epoch-a' })
const open = (requestId = 'open-1', sourceId = 'source-a') => ({ type: 'open', requestId, sourceId })
const answer = id => ({ type: 'answer', id, sdp: { type: 'answer', sdp: 'fixture' } })
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const fixture = (override = {}) => {
  const calls = []
  const grants = new Map()
  const controls = new Map()
  const host = new ProjectionSignals({
    authorize: async (binding, sourceId) => {
      calls.push(`authorize:${sourceId}`)
      if (sourceId === 'foreign') throw new Error('Source is not in this App task')
      const grant = new AbortController()
      grants.set(sourceId, grant)
      return {
        context: binding, sourceId, signal: grant.signal,
        async assertCurrent() { grant.signal.throwIfAborted(); calls.push(`check:${sourceId}`) },
        async receive(data, signal) {
          calls.push(`input:${sourceId}:${data}`)
          signal.throwIfAborted()
          return JSON.stringify({ result: 'applied', operation: JSON.parse(data).operation })
        },
        async disconnect() { calls.push(`disconnect:${sourceId}`) },
        release() { calls.push(`release:${sourceId}`) },
      }
    },
    openMedia: async (lease, signal, receive) => {
      calls.push(`process:${lease.sourceId}`)
      controls.set(lease.sourceId, receive)
      const closed = deferred()
      return {
        offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise,
        async answer() { calls.push(`answer:${lease.sourceId}`) },
        async sendControl(data) { calls.push(`result:${lease.sourceId}:${data}`) },
        async close() { calls.push(`close:${lease.sourceId}`); closed.resolve() },
      }
    },
    ...override,
  })
  return { host, calls, grants, controls }
}

test('signaling carries only SDP/lifetime messages, deduplicates open and binds every identity dimension', async () => {
  const { host, calls } = fixture()
  try {
    const first = await host.receive(context, open())
    assert.deepEqual(await host.receive(context, open()), first)
    assert.equal(calls.filter(call => call.startsWith('process:')).length, 1)
    await assert.rejects(host.receive(context, open('open-1', 'source-b')), /reused/)
    for (const key of Object.keys(context)) {
      const other = { ...context, [key]: `different-${key}` }
      await assert.rejects(host.receive(other, answer(first.id)), /binding/)
      await assert.rejects(host.receive(other, { type: 'close', id: first.id }), /binding/)
    }
    for (const extra of [{ input: 'click' }, { frame: 'pixels' }, { sessionId: 'spoof' }, { path: '/secret' }]) {
      await assert.rejects(host.receive(context, { ...open('extra'), ...extra }), /Invalid projection signaling message/)
    }
    await assert.rejects(host.receive(context, open('foreign', 'foreign')), /not in this App task/)
    await host.receive(context, answer(first.id))
    await assert.rejects(host.receive(context, answer(first.id)), /already submitted/)
    await host.receive(context, { type: 'close', id: first.id })
    await assert.rejects(host.receive(context, answer(first.id)), /binding/)
  } finally { await host.dispose() }
})

test('direct control is checked at execution, ordered, and results come only after the driver', async () => {
  const { host, calls, controls, grants } = fixture()
  const first = await host.receive(context, open())
  const second = await host.receive({ ...context, sessionId: 'task-b' }, open('open-b', 'source-b'))
  await host.receive(context, answer(first.id))
  await host.receive({ ...context, sessionId: 'task-b' }, answer(second.id))
  controls.get('source-a')(JSON.stringify({ operation: 1 }))
  controls.get('source-a')(JSON.stringify({ operation: 2 }))
  await nextTurn()
  const input1 = calls.indexOf('input:source-a:{"operation":1}')
  const result1 = calls.indexOf('result:source-a:{"result":"applied","operation":1}')
  const input2 = calls.indexOf('input:source-a:{"operation":2}')
  assert.ok(input1 >= 0 && result1 > input1 && input2 > result1)
  grants.get('source-a').abort(new Error('App A revoked'))
  controls.get('source-a')(JSON.stringify({ operation: 3 }))
  controls.get('source-b')(JSON.stringify({ operation: 4 }))
  await nextTurn()
  assert.ok(!calls.some(call => call.startsWith('input:source-a:{"operation":3}')))
  assert.ok(calls.includes('input:source-b:{"operation":4}'))
  assert.ok(calls.indexOf('release:source-a') > calls.indexOf('disconnect:source-a'))
  await host.dispose()
})

test('retarget while authority is pending never starts a child or revives an old page epoch', { timeout: 10000 }, async t => {
  const gate = deferred()
  let released = 0
  let started = 0
  const host = new ProjectionSignals({
    authorize: async (binding, sourceId) => {
      await gate.promise
      return { context: binding, sourceId, signal: new AbortController().signal,
        async assertCurrent() {}, async disconnect() {}, release() { released++ } }
    },
    async openMedia() { started++; throw new Error('Old binding started media') },
  })
  t.after(() => { gate.resolve(); return host.dispose() })
  const starting = host.receive(context, open())
  const rejected = assert.rejects(starting, /binding closed/)
  const closing = host.closeBinding(context)
  gate.resolve()
  await closing
  await rejected
  assert.equal(started, 0)
  assert.equal(released, 1)
  await host.dispose()
})

test('cancels pending authority before waiting for a retargeted binding to close', { timeout: 2000 }, async t => {
  const gate = deferred()
  let authoritySignal, closed = false, started = 0
  const host = new ProjectionSignals({
    async authorize(binding, sourceId, signal) {
      authoritySignal = signal
      await new Promise(resolve => {
        gate.promise.then(resolve)
        signal?.addEventListener('abort', resolve, { once: true })
      })
      signal?.throwIfAborted()
      return { context: binding, sourceId, signal: new AbortController().signal,
        async assertCurrent() {}, async disconnect() {}, release() {} }
    },
    async openMedia() { started++; throw new Error('Retargeted page started media') },
  })
  t.after(() => { gate.resolve(); return host.dispose() })
  const pending = assert.rejects(host.receive(context, open('abort-authority')), /binding closed/)
  await nextTurn()
  const closing = host.closeBinding(context).then(() => { closed = true })
  await nextTurn()
  assert.equal(authoritySignal?.aborted, true)
  assert.equal(closed, true)
  assert.equal(started, 0)
  await Promise.all([pending, closing])
})

test('pending connections count toward the page limit before any asynchronous authority work finishes', { timeout: 10000 }, async t => {
  const gate = deferred()
  let authorized = 0
  const host = new ProjectionSignals({
    async authorize() { authorized++; await gate.promise; throw new Error('Fixture authority closed') },
    async openMedia() { throw new Error('Unreachable') },
  })
  t.after(() => { gate.resolve(); return host.dispose() })
  const pending = Array.from({ length: 16 }, (_, index) => assert.rejects(host.receive(context, open(`pending-${index}`)), /authority closed/))
  await assert.rejects(host.receive(context, open('over-limit')), /Too many/)
  assert.equal(authorized, 16)
  gate.resolve()
  await Promise.all(pending)
  await host.dispose()
})

test('closing connections retain their capacity until the driver drains, and reentrant abort releases once', { timeout: 10000 }, async t => {
  const drain = deferred()
  let released = 0
  const grants = []
  const host = new ProjectionSignals({
    async authorize(binding, sourceId) {
      const grant = new AbortController(); grants.push(grant)
      return { context: binding, sourceId, signal: grant.signal,
        async assertCurrent() {}, async disconnect() { await drain.promise }, release() { released++ } }
    },
    async openMedia(lease, signal) {
      const closed = deferred()
      signal.addEventListener('abort', () => grants.at(-1).abort())
      return { offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise,
        async close() { closed.resolve() } }
    },
  })
  t.after(() => { drain.resolve(); return host.dispose() })
  const opened = []
  for (let index = 0; index < 16; index++) opened.push(await host.receive(context, open(`drain-${index}`, `source-${index}`)))
  const closing = opened.map(entry => host.receive(context, { type: 'close', id: entry.id }))
  await assert.rejects(host.receive(context, open('during-drain')), /Too many/)
  drain.resolve()
  await Promise.all(closing)
  assert.equal(released, 16)
  await host.dispose()
})

test('cleanup preserves the driver failure while still closing media and releasing authority', async t => {
  let closed = 0, released = 0
  const host = new ProjectionSignals({
    async authorize(binding, sourceId) {
      return { context: binding, sourceId, signal: new AbortController().signal,
        async assertCurrent() {}, async disconnect() { throw new Error('Driver cleanup failed') }, release() { released++ } }
    },
    async openMedia() {
      return { offer: { type: 'offer', sdp: 'fixture' }, closed: new Promise(() => {}),
        async close() { closed++; throw new Error('Media cleanup failed') } }
    },
  })
  t.after(() => host.dispose())
  const media = await host.receive(context, open('cleanup-failure'))
  await assert.rejects(host.receive(context, { type: 'close', id: media.id }), /Driver cleanup failed/)
  assert.equal(closed, 1)
  assert.equal(released, 1)
})

test('a local authority lease owns a real native helper and closing the binding awaits its exit', { timeout: 15000 }, async () => {
  let disconnected = false
  let released = false
  let actualMedia
  const lifetime = new AbortController()
  const host = new ProjectionSignals({
    async authorize(binding, sourceId) {
      return { context: binding, sourceId, signal: lifetime.signal,
        async assertCurrent() { lifetime.signal.throwIfAborted() },
        async disconnect() { disconnected = true },
        release() { assert.equal(disconnected, true); released = true },
      }
    },
    async openMedia(lease, signal, onControl) {
      actualMedia = await openMediaProcess({ executable: process.env.GUGU_TEST_MEDIA_HELPER, ffmpeg: process.env.GUGU_PROJECTION_FFMPEG,
        width: 128, height: 96, fps: 10, bitrate: 500000, signal, onControl })
      return actualMedia
    },
  })
  await host.receive(context, open())
  await host.closeBinding(context)
  assert.equal(released, true)
  await assert.rejects(actualMedia.closed, /binding closed/)
  await host.dispose()
})
