import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeBridge } from './native-bridge.mjs'

test('native replies cannot cross owner or session and late replies are ignored', async () => {
  const events = []
  const bridge = createNativeBridge((event) => events.push(event))
  const task = bridge.call('calendar.events.list', {}, undefined, { ownerId: 'a', sessionId: 'one' })
  const id = events[0].id
  assert.equal(bridge.resolve({ id, ownerId: 'b', sessionId: 'one', result: { secret: true } }), false)
  assert.equal(bridge.resolve({ id, ownerId: 'a', sessionId: 'other', result: { secret: true } }), false)
  assert.equal(bridge.resolve({ id, ownerId: 'a', sessionId: 'one', result: { ok: true } }), true)
  assert.deepEqual(await task, { ok: true })
  assert.equal(bridge.resolve({ id, result: {} }), false)
})

test('cancellation removes a pending tool and rejects an already aborted call before emission', async () => {
  const events = []
  const bridge = createNativeBridge((event) => events.push(event))
  const controller = new AbortController()
  const task = bridge.call('calendar.events.list', {}, controller.signal)
  const rejection = assert.rejects(task, /cancelled/)
  controller.abort(new Error('cancelled'))
  await rejection
  assert.equal(bridge.resolve({ id: events[0].id, result: {} }), false)
  await assert.rejects(bridge.call('calendar.events.list', {}, controller.signal), /cancelled/)
  assert.equal(events.length, 1)
})

test('closing the runtime settles all outstanding callers', async () => {
  const bridge = createNativeBridge(() => {})
  const one = assert.rejects(bridge.call('one', {}), /关闭/)
  const two = assert.rejects(bridge.call('two', {}), /关闭/)
  bridge.close()
  await Promise.all([one, two])
})

test('native timeouts and lost runtime replies retain an unknown execution outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  const bridge = createNativeBridge((event) => events.push(event))
  const timedOut = assert.rejects(bridge.call('phone.native', { method: 'calendarCreate' }), { code: 'execution_unknown' })
  t.mock.timers.tick(180_000)
  await timedOut
  assert.equal(bridge.resolve({ id: events[0].id, result: { ok: true } }), false)
  const disconnected = assert.rejects(bridge.call('phone.native', { method: 'calendarCreate' }), { code: 'execution_unknown' })
  bridge.close()
  await disconnected
})
