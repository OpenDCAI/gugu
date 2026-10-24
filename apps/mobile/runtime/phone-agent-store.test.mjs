import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPhoneAgentStore, admitPhoneJob, stableId } from './phone-agent-store.mjs'

const owner = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const agent = '22a953e8-e021-4789-9fc9-e41ecb37295b'

test('an admitted cloud message is durable and replay keeps the original task exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-store-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    const id = stableId('message', 1)
    await admitPhoneJob(store, { id, agentUserId: agent, prompt: 'first authoritative message' })
    await admitPhoneJob(store, { id, agentUserId: agent, prompt: 'a replay must not replace it' })
    const cold = await openPhoneAgentStore(root, owner)
    assert.equal(Object.keys(cold.state.jobs).length, 1)
    assert.equal(cold.state.jobs[id].prompt, 'first authoritative message')
    assert.equal(cold.state.jobs[id].status, 'queued')
  } finally { await rm(root, { recursive: true }) }
})

test('a process crash never silently replays a running turn and owners remain isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-crash-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    const id = stableId('message', 2)
    store.state.agents[agent] = { agentUserId: agent, status: 'working' }
    await admitPhoneJob(store, { id, agentUserId: agent, prompt: 'could have changed the phone' })
    store.state.jobs[id].status = 'running'
    await store.save()
    const cold = await openPhoneAgentStore(root, owner)
    assert.equal(cold.state.jobs[id].status, 'interrupted')
    assert.equal(cold.state.agents[agent].status, 'error')
    const other = await openPhoneAgentStore(root, 'fba789f0-53e9-4b5b-a289-c3cce6151234')
    assert.deepEqual(other.state.jobs, {})
    assert.equal(JSON.parse(await readFile(join(cold.directory, 'host.json'), 'utf8')).jobs[id].status, 'interrupted')
  } finally { await rm(root, { recursive: true }) }
})

test('a duplicate admission cannot acknowledge an unsaved job until the real journal write recovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-admission-failure-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    const previous = await admitPhoneJob(store, { id: stableId('previous'), agentUserId: agent, prompt: 'already completed' })
    previous.status = 'done'
    await store.save()
    const path = join(store.directory, 'host.json')
    const saved = `${path}.before-failure`
    await rename(path, saved)
    // A directory at the journal path makes the production rename fail regardless of UID or
    // filesystem permission bypasses; no save implementation is mocked in this case.
    await mkdir(path)
    const input = { id: stableId('unsaved-message'), agentUserId: agent, prompt: 'the original authoritative input', route: { kind: 'task' } }
    let acknowledged = 0
    const admit = async (value) => { const job = await admitPhoneJob(store, value); acknowledged++; return job }
    const filesystemFailure = (error) => ['EISDIR', 'EPERM', 'ENOTEMPTY'].includes(error.code)
    await assert.rejects(admit(input), filesystemFailure)
    const original = store.state.jobs[input.id]
    const beforeRetry = structuredClone(store.state.jobs)
    const order = Object.keys(store.state.jobs)
    assert.equal(acknowledged, 0)
    const retry = { ...input, prompt: 'a retry must never replace the original', status: 'running' }
    await assert.rejects(admit(retry), filesystemFailure)
    assert.equal(acknowledged, 0)
    assert.equal(store.state.jobs[input.id], original)
    assert.deepEqual(store.state.jobs, beforeRetry)
    assert.deepEqual(Object.keys(store.state.jobs), order)
    await rm(path, { recursive: true })
    await rename(saved, path)
    assert.equal(await admit(retry), original)
    assert.equal(acknowledged, 1)
    assert.deepEqual(store.state.jobs, beforeRetry)
    assert.deepEqual(Object.keys(store.state.jobs), order)
    const cold = await openPhoneAgentStore(root, owner)
    assert.deepEqual(cold.state.jobs, beforeRetry)
    assert.deepEqual(Object.keys(cold.state.jobs), order)
    assert.equal(cold.state.jobs[input.id].status, 'queued')
    assert.equal(cold.state.jobs[previous.id].status, 'done')
  } finally { await rm(root, { recursive: true }) }
})
