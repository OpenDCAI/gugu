import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferPhonePreparation, phonePreparationExpired, phonePreparationMayRun } from './phone-agent-preparation-queue.mjs'

const networkError = () => Object.assign(new TypeError('fetch failed'), { phonePreparation: true })

test('all jobs share one durable cooldown; heartbeat success alone cannot release a retry burst', () => {
  const state = {}, job = {}
  assert.equal(deferPhonePreparation(state, job, networkError(), 0, () => 1), true)
  const recovered = JSON.parse(JSON.stringify(state))
  assert.equal(phonePreparationMayRun(recovered, 120_000), false)
  recovered.preparationBackoff.awaitingHeartbeat = false
  assert.equal(phonePreparationMayRun(recovered, 1_000), false)
  assert.equal(phonePreparationMayRun(recovered, 30_000), true)
  assert.equal(deferPhonePreparation(recovered, job, networkError(), 30_000, () => 1), true)
  assert.equal(recovered.preparationBackoff.notBefore, 90_000)
})

test('subsequent failures cannot extend a job beyond its original thirty-minute wait', () => {
  const state = {}, job = {}
  assert.equal(deferPhonePreparation(state, job, networkError(), 0), true)
  assert.equal(deferPhonePreparation(state, job, networkError(), 15 * 60_000), true)
  assert.equal(job.networkWait.expiresAt, 30 * 60_000)
  assert.equal(phonePreparationExpired(job, 30 * 60_000), true)
  assert.equal(deferPhonePreparation(state, job, networkError(), 30 * 60_000), false)
})

test('execution failures, permanent refusals and cancellations never enter automatic replay', () => {
  for (const error of [new TypeError('fetch failed'), Object.assign(networkError(), { status: 403 }), Object.assign(networkError(), { status: 429 })]) {
    assert.equal(deferPhonePreparation({}, {}, error), false)
  }
  assert.equal(deferPhonePreparation({}, { cancelRequested: true }, networkError()), false)
})

test('a service Retry-After applies to the whole phone, including newly admitted tasks', () => {
  const state = {}
  assert.equal(deferPhonePreparation(state, {}, Object.assign(networkError(), { category: 'service', status: 503, retryable: true, retryAt: 600_000 }), 0), true)
  state.preparationBackoff.awaitingHeartbeat = false
  assert.equal(phonePreparationMayRun(state, 599_999), false)
  assert.equal(phonePreparationMayRun(state, 600_000), true)
})
