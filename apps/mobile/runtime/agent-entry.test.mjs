import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bindAgentEntry, createAgentEntry } from './agent-entry.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture(overrides = {}) {
  const events = [], cancellations = []
  let bridgeCloses = 0
  const entry = createAgentEntry({
    runTurn: async () => ({ status: 'done' }), cancelTurn: (id) => cancellations.push(id),
    startPhoneAgentHost: async () => ({ close: async () => {}, handle: async () => {} }),
    bridge: { call: async () => ({}), resolve: () => {}, close: () => { bridgeCloses++ } },
    output: (event) => events.push(event), ...overrides,
  })
  return { entry, events, cancellations, get bridgeCloses() { return bridgeCloses }, send: (command) => entry.handleLine(JSON.stringify(command)) }
}

test('host calls before initialization or during deferred startup receive correlated errors and are never replayed', async () => {
  const starting = deferred(), handled = []
  const f = fixture({ startPhoneAgentHost: () => starting.promise })
  const beforeConfigure = { type: 'host_call', ownerId: 'owner', id: 'before-configure', channel: 'sessionTimeline.sessionCreateOptions', args: [] }
  f.send(beforeConfigure)
  assert.deepEqual(f.events, [{ type: 'host_result', ownerId: 'owner', id: beforeConfigure.id,
    error: { code: 'host_not_ready', message: '手机宿主尚未就绪，请稍后重试' } }])

  f.send({ type: 'host_start', ownerId: 'owner' })
  await tick()
  const calls = [
    { ...beforeConfigure, id: 'options-during-startup' },
    { ...beforeConfigure, id: 'create-during-startup', channel: 'sessionTimeline.sessionCreate', args: [{ prompt: 'must not create a task later' }] },
  ]
  for (const call of calls) f.send(call)
  assert.deepEqual(f.events.slice(1), calls.map((call) => ({ type: 'host_result', ownerId: 'owner', id: call.id,
    error: { code: 'host_not_ready', message: '手机宿主尚未就绪，请稍后重试' } })))

  starting.resolve({ close: async () => {}, handle: async (command) => { handled.push(command) } })
  await tick()
  assert.deepEqual(handled, [])
  const retry = { ...beforeConfigure, id: 'options-after-startup' }
  f.send(retry)
  await tick()
  assert.deepEqual(handled, [retry])
  assert.equal(f.events.length, 3)
  await f.entry.close()
})

test('host calls after a failed startup also settle instead of waiting for a future host', async () => {
  const starting = deferred()
  const f = fixture({ startPhoneAgentHost: () => starting.promise })
  f.send({ type: 'configure', ownerId: 'owner' })
  await tick()
  starting.reject(new Error('fixture startup failed'))
  await tick()
  f.send({ type: 'host_call', ownerId: 'owner', id: 'after-failed-start', channel: 'sessionTimeline.sessionCreateOptions', args: [] })
  assert.deepEqual(f.events.at(-1), { type: 'host_result', ownerId: 'owner', id: 'after-failed-start',
    error: { code: 'host_not_ready', message: '手机宿主尚未就绪，请稍后重试' } })
  await f.entry.close()
})

test('EOF cancels the running legacy turn and waits for it to release its work', async () => {
  const turn = deferred()
  let runs = 0
  const f = fixture({ runTurn: async () => { runs++; return turn.promise } })
  f.send({ type: 'run', sessionId: 'legacy', ownerId: 'owner' })
  await tick()
  let closed = false
  const closing = f.entry.close().then(() => { closed = true })
  assert.deepEqual(f.cancellations, ['legacy'])
  assert.equal(f.bridgeCloses, 1)
  f.send({ type: 'run', sessionId: 'late' })
  f.send({ type: 'host_start', ownerId: 'late' })
  await tick()
  assert.equal(closed, false)
  assert.equal(runs, 1)
  turn.resolve({ status: 'cancelled' })
  await closing
  await f.entry.close()
  assert.equal(f.bridgeCloses, 1)
  assert.deepEqual(f.events, [])
})

test('EOF waits for host startup and its close, without forwarding a waiting configure', async () => {
  const starting = deferred(), shuttingDown = deferred()
  let starts = 0, closes = 0, handled = 0
  const f = fixture({ startPhoneAgentHost: async () => { starts++; return starting.promise } })
  f.send({ type: 'host_start', ownerId: 'owner' })
  await tick()
  f.send({ type: 'configure', ownerId: 'owner' })
  let closed = false
  const closing = f.entry.close().then(() => { closed = true })
  f.send({ type: 'host_start', ownerId: 'late' })
  starting.resolve({ close: async () => { closes++; await shuttingDown.promise }, handle: async () => { handled++ } })
  await tick()
  assert.equal(starts, 1)
  assert.equal(closes, 1)
  assert.equal(handled, 0)
  assert.equal(closed, false)
  shuttingDown.resolve()
  await closing
})

test('EOF before an admitted startup runs prevents the host and legacy factories from starting', async () => {
  for (const type of ['host_start', 'run']) {
    let starts = 0
    const f = fixture({ runTurn: async () => { starts++; return { status: 'done' } }, startPhoneAgentHost: async () => { starts++; return { close: async () => {} } } })
    f.send({ type, sessionId: 'legacy', ownerId: 'owner' })
    await f.entry.close()
    assert.equal(starts, 0)
    assert.deepEqual(f.events, [])
  }
})

test('EOF waits for a failed startup and exposes a real host-close failure to its caller', async () => {
  const starting = deferred()
  const f = fixture({ startPhoneAgentHost: () => starting.promise })
  f.send({ type: 'host_start', ownerId: 'owner' })
  await tick()
  const closing = f.entry.close()
  starting.reject(new Error('startup failed'))
  await closing
  const g = fixture({ startPhoneAgentHost: async () => ({ close: async () => { throw new Error('close failed') } }) })
  g.send({ type: 'host_start', ownerId: 'owner' })
  await tick()
  await assert.rejects(g.entry.close(), /close failed/)
})

test('a host already starting at EOF cannot open a new turn or native call while it finishes startup', async () => {
  const starting = deferred()
  let hooks, turns = 0, nativeCalls = 0
  const f = fixture({
    runTurn: async () => { turns++; return { status: 'done' } },
    startPhoneAgentHost: (_config, supplied) => { hooks = supplied; return starting.promise },
    bridge: { resolve: () => {}, close: () => {}, call: async () => { nativeCalls++; return {} } },
  })
  f.send({ type: 'host_start', ownerId: 'owner' })
  await tick()
  const closing = f.entry.close()
  assert.throws(() => hooks.runTurn({ sessionId: 'late' }, {}), /输入已关闭/)
  assert.throws(() => hooks.nativeCall('calendar.events.list', {}, undefined, {}), /输入已关闭/)
  assert.equal(turns, 0)
  assert.equal(nativeCalls, 0)
  starting.resolve({ close: async () => {} })
  await closing
})

test('a broken parent stdout pipe follows the real entry shutdown binding and awaits cancellation', async () => {
  const turn = deferred(), input = new EventEmitter(), output = new EventEmitter(), failures = []
  let exits = 0
  const f = fixture({ runTurn: async () => turn.promise })
  const bound = bindAgentEntry(f.entry, { input, output, onError: (error) => failures.push(error), onTimeout: () => assert.fail('graceful cleanup should finish'), onClosed: () => { exits++ } })
  input.emit('line', JSON.stringify({ type: 'run', sessionId: 'legacy', ownerId: 'owner' }))
  await tick()
  assert.doesNotThrow(() => output.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })))
  assert.deepEqual(f.cancellations, ['legacy'])
  let closed = false
  const closing = bound.close().then(() => { closed = true })
  input.emit('close')
  await tick()
  assert.equal(closed, false)
  assert.equal(exits, 0)
  assert.equal(f.bridgeCloses, 1)
  turn.resolve({ status: 'cancelled' })
  await closing
  assert.deepEqual(f.events, [])
  assert.deepEqual(failures, [])
  assert.equal(exits, 1)
})

test('lost-parent shutdown has a deadline even when real host startup never settles', async () => {
  const starting = deferred(), input = new EventEmitter(), output = new EventEmitter(), timeouts = []
  let fireDeadline, scheduledMs, cleared = 0
  const f = fixture({ startPhoneAgentHost: () => starting.promise })
  const bound = bindAgentEntry(f.entry, {
    input, output, onError: (error) => assert.fail(error.message), onTimeout: (failure) => timeouts.push(failure),
    timers: { setTimeout: (callback, ms) => { fireDeadline = callback; scheduledMs = ms; return 'deadline' }, clearTimeout: (id) => { assert.equal(id, 'deadline'); cleared++ } },
  })
  input.emit('line', JSON.stringify({ type: 'host_start', ownerId: 'owner' }))
  await tick()
  input.emit('close')
  assert.equal(scheduledMs, 5_000)
  assert.equal(cleared, 0)
  fireDeadline()
  assert.deepEqual(timeouts, [{ reason: 'native_parent_channel_closed', timeoutMs: 5_000 }])
  starting.resolve({ close: async () => {} })
  await bound.close()
  assert.equal(cleared, 1)
})
