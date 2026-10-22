import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phoneMemoryTools } from './phone-agent-memory.mjs'

function fixture() {
  const agent = { agentUserId: 'agent', sessionId: 'task' }, job = { usedGroups: [], permissionRequirements: [] }
  const store = { state: { ownerId: 'owner' }, save: async () => {} }
  const calls = []
  const authorize = async (...args) => { calls.push(args) }
  const create = (patch = {}) => Object.fromEntries(phoneMemoryTools({ agent, job, store, authorize, ...patch }).map((tool) => [tool.name, tool]))
  return { agent, job, store, calls, create }
}

test('task memory persists across a new turn and context epoch, keeping timestamp and CAS version', async () => {
  const f = fixture(), tools = f.create()
  const written = await tools.phone_memory_save.execute('write', { key: '偏好', text: '回答保持简短' })
  const next = f.create({ agent: { ...f.agent, contextEpoch: 'next' }, job: { usedGroups: [], permissionRequirements: [] } })
  const found = await next.phone_memory_search.execute('read', { query: '简短' })
  assert.equal(found.details.notes[0].text, '回答保持简短')
  assert.equal(found.details.notes[0].sha256, written.details.sha256)
  const same = await next.phone_memory_save.execute('retry', { key: '偏好', text: '回答保持简短' })
  assert.equal(same.details.updated_at, written.details.updated_at)
  await assert.rejects(next.phone_memory_save.execute('conflict', { key: '偏好', text: 'changed' }), { code: 'conflict' })
  const updated = await next.phone_memory_save.execute('replace', { key: '偏好', text: '回答使用中文', expected_sha256: written.details.sha256 })
  assert.notEqual(updated.details.sha256, written.details.sha256)
  await assert.rejects(next.phone_memory_delete.execute('delete', { key: '偏好', expected_sha256: written.details.sha256 }), { code: 'conflict' })
  assert.equal((await next.phone_memory_delete.execute('delete', { key: '偏好', expected_sha256: updated.details.sha256 })).details.deleted, true)
})

test('never reads another Agent/session/owner memory, and bounds stored notes', async () => {
  const f = fixture(), tools = f.create()
  await tools.phone_memory_save.execute('write', { key: 'private', text: '仅本任务' })
  for (const patch of [{ agent: { ...f.agent, agentUserId: 'other' } }, { agent: { ...f.agent, sessionId: 'other' } }, { store: { ...f.store, state: { ...f.store.state, ownerId: 'other' } } }]) {
    assert.deepEqual((await f.create(patch).phone_memory_search.execute('read', {})).details.notes, [])
  }
  await assert.rejects(tools.phone_memory_save.execute('write', { key: 'x', text: 'a'.repeat(8193) }), { code: 'invalid_args' })
})

test('saved phone-data provenance cannot be removed by a later context with fewer grants', async () => {
  const f = fixture()
  f.job.usedGroups = ['calendar']; f.job.permissionRequirements = [{ permission: 'calendarRead', state: 'granted' }]
  const saved = await f.create().phone_memory_save.execute('write', { key: '安排', text: '日历摘要' })
  const newJob = { usedGroups: [], permissionRequirements: [] }
  let revoked = true
  const later = f.create({ job: newJob, authorize: async (groups) => { if (revoked && groups.includes('calendar')) throw Object.assign(new Error('revoked'), { code: 'revoked' }) } })
  assert.deepEqual((await later.phone_memory_search.execute('read', { query: '日历摘要' })).details.notes, [])
  assert.deepEqual((await later.phone_memory_search.execute('read', { query: 'nonmatching word' })).details.notes, [])
  await assert.rejects(later.phone_memory_save.execute('overwrite', { key: '安排', text: '摘要2', expected_sha256: saved.details.sha256 }), { code: 'revoked' })
  revoked = false
  await later.phone_memory_search.execute('read', {})
  assert.deepEqual(newJob.usedGroups, ['calendar'])
  assert.deepEqual(newJob.permissionRequirements, f.job.permissionRequirements)
})

test('concurrent updates of one version cannot both succeed and failed persistence does not claim a save', async () => {
  const f = fixture(), tools = f.create()
  const saved = await tools.phone_memory_save.execute('write', { key: 'decision', text: 'one' })
  const outcomes = await Promise.allSettled(['two', 'three'].map((text) => tools.phone_memory_save.execute(text, { key: 'decision', text, expected_sha256: saved.details.sha256 })))
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find((entry) => entry.status === 'rejected').reason.code, 'conflict')
  f.store.save = async () => { throw new Error('disk full') }
  await assert.rejects(tools.phone_memory_save.execute('failed', { key: 'new', text: 'not durable' }), /disk full/)
  assert.equal(Object.values(f.store.state.memory).some((entry) => entry.key === 'new'), false)
})
