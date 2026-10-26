import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhonePreparation, phoneRequestFailure, phoneRequestOperation, phonePreparationFailureText } from './phone-agent-network.mjs'

test('preparation retries transport failure without retaining raw request data', async () => {
  const failures = []
  let attempts = 0
  const prepare = createPhonePreparation({ signal: new AbortController().signal, retryDelayMs: 0, record: value => failures.push(value) })
  const result = await prepare('model-access.issue', async () => {
    if (++attempts === 1) throw new TypeError('fetch failed https://private.invalid?token=secret', { cause: Object.assign(new Error('private details'), { code: 'ENOTFOUND' }) })
    return 'ready'
  })
  assert.equal(result, 'ready')
  assert.equal(attempts, 2)
  assert.deepEqual(failures, [{ operation: 'model-access.issue', attempt: 1, category: 'dns', code: 'ENOTFOUND', retryable: true, retry: true }])
  assert.doesNotMatch(JSON.stringify(failures), /secret|https|private/)
})

test('fast failures use the whole deadline with capped exponential backoff, not an attempt limit', async () => {
  let time = 0, requests = 0
  const pauses = []
  const prepare = createPhonePreparation({ signal: new AbortController().signal, budgetMs: 45_000, random: () => 1, now: () => time, wait: async ms => { pauses.push(ms); time += ms } })
  await assert.rejects(prepare('model-access.issue', async () => { requests++; throw new TypeError('fetch failed') }))
  assert.equal(time, 45_000)
  assert.equal(requests, 9)
  assert.deepEqual(pauses.slice(0, 5), [500, 1_000, 2_000, 4_000, 8_000])
  assert.ok(pauses.every(ms => ms <= 8_000))
  const bounded = createPhonePreparation({ signal: new AbortController().signal, budgetMs: 1000, now: () => time, wait: async ms => { time += ms } })
  await bounded('agent.verify', async () => { time += 800 })
  requests = 0
  await assert.rejects(bounded('model-access.issue', async () => { requests++; throw new TypeError('fetch failed') }))
  assert.ok(requests >= 1)
})

test('a server Retry-After beyond this window is retained instead of issuing another request', async () => {
  let time = 0, requests = 0
  const error = Object.assign(new Error('busy'), { category: 'service', status: 503, retryable: true, retryAt: 120_000 })
  const prepare = createPhonePreparation({ signal: new AbortController().signal, now: () => time, wait: async ms => { time += ms } })
  await assert.rejects(prepare('model-access.issue', async () => { requests++; throw error }), value => value.retryAt === 120_000)
  assert.equal(requests, 1)
  assert.equal(time, 45_000)
})

test('a queued recovery probe makes one attempt rather than resetting the full retry burst', async () => {
  let requests = 0
  const prepare = createPhonePreparation({ signal: new AbortController().signal, recoveryProbe: true,
    wait: async () => { throw new Error('a probe must return to the shared cooldown instead') } })
  await assert.rejects(prepare('model-access.issue', async () => { requests++; throw new TypeError('fetch failed') }), error => error.phonePreparation === true)
  assert.equal(requests, 1)
})

test('cancellation interrupts backoff; authorization and quota refusals never retry', async () => {
  const controller = new AbortController()
  let calls = 0
  const prepare = createPhonePreparation({ signal: controller.signal, record: () => controller.abort(Object.assign(new Error('cancelled'), { cancelled: true })) })
  await assert.rejects(prepare('model-access.issue', async () => { calls++; throw new TypeError('fetch failed') }), error => error.cancelled === true)
  assert.equal(calls, 1)
  for (const status of [400, 401, 403, 429]) {
    calls = 0
    await assert.rejects(createPhonePreparation({ signal: new AbortController().signal })('model-access.issue', async () => { calls++; throw Object.assign(new Error('refused'), { status }) }))
    assert.equal(calls, 1)
  }
})

test('request labels include the operation but never identifiers, URLs or tokens', () => {
  assert.equal(phoneRequestOperation('https://private.invalid/auth/v1/token?grant_type=refresh_token'), 'auth.refresh')
  assert.equal(phoneRequestOperation('https://private.invalid/functions/v1/model-access?secret=bad', { body: JSON.stringify({ action: 'issue', token: 'bad' }) }), 'model-access.issue')
  assert.equal(phoneRequestOperation('https://private.invalid/rest/v1/users?select=private&token=bad'), 'table.users')
  assert.equal(phoneRequestOperation('https://private.invalid/rest/v1/rpc/set_agent_runtime_state'), 'rpc.set_agent_runtime_state')
  assert.equal(phoneRequestFailure(new AggregateError([Object.assign(new Error('private'), { code: 'ECONNRESET' })])).category, 'connection_reset')
  assert.equal(phonePreparationFailureText(new TypeError('fetch failed')), '这次手机任务没能完成，网络暂时连不上。')
})
