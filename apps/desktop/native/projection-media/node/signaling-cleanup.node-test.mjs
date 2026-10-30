import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { ProjectionSignals } from './signaling.mjs'

const context = { ownerId: 'owner', deviceId: 'device', appId: 'app', sessionId: 'task', pageId: 'page', epoch: '1' }
const open = { type: 'open', requestId: 'cleanup', sourceId: 'source' }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const fixture = (overrides = {}) => {
  const closed = deferred(), reports = [], events = []
  let control
  const host = new ProjectionSignals({
    onError: event => reports.push(event),
    async authorize(binding, sourceId) { return { context: binding, sourceId, signal: new AbortController().signal,
      async assertCurrent() {}, async receive() {}, async disconnect() { events.push('disconnect') },
      release() { events.push('release') }, ...overrides.lease } },
    async openMedia(lease, signal, receive) { control = receive; return {
      offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise, async answer() {},
      async close() { events.push('close'); closed.resolve() }, ...overrides.media } },
    ...overrides.dependencies,
  })
  return { host, reports, events, closed, control: data => control(data) }
}

test('background grant revocation reports cleanup failure instead of silently dropping it', async t => {
  const grant = new AbortController(), closed = deferred(), reports = []
  const failure = new Error('Media cleanup required SIGKILL')
  let released = 0
  const host = new ProjectionSignals({
    onError: event => reports.push(event),
    async authorize(binding, sourceId) { return { context: binding, sourceId, signal: grant.signal,
      async assertCurrent() {}, async disconnect() {}, release() { released++ } } },
    async openMedia() { return { offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise,
      async close() { throw failure } } },
  })
  t.after(() => host.dispose())
  await host.receive(context, open)
  grant.abort(new Error('App revoked'))
  await nextTurn()
  assert.equal(released, 1)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].error, failure)
  assert.deepEqual(reports[0].context, context)
  assert.equal(reports[0].sourceId, 'source')
})

test('closing drains input before disconnect and awaits disconnect before stopping media', async t => {
  const input = deferred(), disconnect = deferred(), closed = deferred(), events = []
  let control
  const host = new ProjectionSignals({
    onError: error => { throw error.error },
    async authorize(binding, sourceId) { return { context: binding, sourceId, signal: new AbortController().signal,
      async assertCurrent() {}, async receive() { events.push('input-start'); await input.promise; events.push('input-end') },
      async disconnect() { events.push('disconnect-start'); await disconnect.promise; events.push('disconnect-end') },
      release() { events.push('release') } } },
    async openMedia(lease, signal, receive) { control = receive; return {
      offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise, async answer() {},
      async close() { events.push('media-close'); closed.resolve() } } },
  })
  t.after(async () => { input.resolve(); disconnect.resolve(); await host.dispose() })
  const first = await host.receive(context, open)
  await host.receive(context, { type: 'answer', id: first.id, sdp: { type: 'answer', sdp: 'fixture' } })
  control('input')
  await nextTurn()
  const closing = host.closeBinding(context)
  await nextTurn()
  assert.deepEqual(events, ['input-start'])
  input.resolve(); await nextTurn()
  assert.deepEqual(events, ['input-start', 'input-end', 'disconnect-start'])
  disconnect.resolve(); await closing
  assert.deepEqual(events, ['input-start', 'input-end', 'disconnect-start', 'disconnect-end', 'media-close', 'release'])
})

test('helper exit and driver failure report their cause once and release their binding', async t => {
  for (const kind of ['media-exit', 'control']) {
    const failure = new Error(`${kind} failed`)
    const f = fixture({ lease: { async receive() { throw failure } },
      media: { async close() { throw failure } } })
    t.after(() => f.host.dispose())
    const first = await f.host.receive(context, open)
    await f.host.receive(context, { type: 'answer', id: first.id, sdp: { type: 'answer', sdp: 'fixture' } })
    if (kind === 'media-exit') f.closed.reject(failure)
    else f.control('input')
    await nextTurn()
    assert.deepEqual(f.events, ['disconnect', 'release'])
    assert.equal(f.reports.length, 1)
    assert.equal(f.reports[0].error, failure)
    assert.equal(f.reports[0].phase, kind)
    await assert.rejects(f.host.receive(context, { type: 'close', id: first.id }), /not in this App task binding/)
  }
})

test('handshake timeout and early control rejection both report before cleanup', async t => {
  const originalTimeout = globalThis.setTimeout
  let timeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 30000) { timeout = callback; return { unref() {} } }
    return originalTimeout(callback, ms, ...args)
  })
  for (const kind of ['handshake', 'control-admission']) {
    const f = fixture()
    t.after(() => f.host.dispose())
    await f.host.receive(context, open)
    if (kind === 'handshake') timeout()
    else f.control('too early')
    await nextTurn()
    assert.deepEqual(f.events, ['disconnect', 'close', 'release'])
    assert.equal(f.reports.length, 1)
    assert.equal(f.reports[0].phase, kind)
    assert.match(f.reports[0].error.message, kind === 'handshake' ? /handshake timed out/ : /before readiness/)
  }
})

test('answer preserves its primary failure while every cleanup failure reaches the sink', async t => {
  const primary = new Error('Answer rejected'), disconnect = new Error('Disconnect failed'), media = new Error('Close failed')
  const f = fixture({ lease: { async disconnect() { throw disconnect } },
    media: { async answer() { throw primary }, async close() { throw media } } })
  t.after(() => f.host.dispose())
  const first = await f.host.receive(context, open)
  await assert.rejects(f.host.receive(context, { type: 'answer', id: first.id, sdp: { type: 'answer', sdp: 'fixture' } }), reason => reason === primary)
  assert.deepEqual(f.reports.map(event => event.error), [disconnect, media])
  assert.deepEqual(f.events, ['release'])
})

test('a failed diagnostic callback falls back to stderr without interrupting release', async t => {
  const output = [], failure = new Error('Encoder crashed')
  t.mock.method(process.stderr, 'write', text => { output.push(text); return true })
  const f = fixture({ dependencies: { onError() { throw new Error('Reporter failed') } } })
  t.after(() => f.host.dispose())
  await f.host.receive(context, open)
  f.closed.reject(failure)
  await nextTurn()
  assert.deepEqual(f.events, ['disconnect', 'close', 'release'])
  const diagnostic = JSON.parse(output.join(''))
  assert.equal(diagnostic.error, failure.message)
  assert.equal(diagnostic.reporterError, 'Reporter failed')
  assert.equal(diagnostic.phase, 'media-exit')
})
