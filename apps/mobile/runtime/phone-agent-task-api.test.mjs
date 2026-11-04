import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { createPhoneTaskApi } from './phone-agent-task-api.mjs'

test('admission retains raw caption and files without resolving bytes, permits replay and following text', async () => {
  const store = { state: { jobs: {} } }
  const agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  const inputs = []
  let resolutions = 0
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent, verifyAgent: async () => {},
    turnFiles: async () => { resolutions++; return { text: '[File not saved: File is no longer available]' } },
    admit: async input => { if (!store.state.jobs[input.id]) { store.state.jobs[input.id] = input; inputs.push(input) } },
  })
  const input = { conversationId: agent.sessionId, text: 'original caption', clientRequestId: randomUUID(), files: [{ itemId: randomUUID(), version: 1 }] }
  const first = await api('sessionTimeline.sessionSend', [input], randomUUID())
  assert.deepEqual(Object.keys(first.value).sort(), ['accepted', 'messageId'])
  assert.equal(inputs[0].prompt, 'original caption')
  assert.deepEqual(inputs[0].files, input.files)
  assert.deepEqual(await api('sessionTimeline.sessionSend', [input], randomUUID()), first)
  assert.equal(resolutions, 0)
  await api('sessionTimeline.sessionSend', [{ conversationId: agent.sessionId, text: 'following text', clientRequestId: randomUUID() }], randomUUID())
  assert.equal(inputs[1].prompt, 'following text')
})

test('the same seen action persists the phone host read bit, preserves the error and fails without dismissing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-seen-'))
  try {
    const ownerId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID()
    const store = await openPhoneAgentStore(root, ownerId)
    const agent = { agentUserId: agentId, sessionId, status: 'error', lastError: 'original failure', agentStatusSeen: 0 }
    store.state.agents[agentId] = agent
    await store.save()
    let published = 0, verified = 0
    const api = createPhoneTaskApi({ store, findSession: id => { assert.equal(id, sessionId); return agent }, verifyAgent: async id => { assert.equal(id, agentId); verified++ }, publish: () => published++ })
    assert.deepEqual(await api('sessions.markSessionSeen', [sessionId]), { value: undefined })
    const path = join(store.directory, 'host.json')
    const saved = JSON.parse(await readFile(path, 'utf8')).agents[agentId]
    assert.equal(saved.agentStatusSeen, 1)
    assert.equal(saved.status, 'error')
    assert.equal(saved.lastError, 'original failure')
    assert.equal(published, 1)
    agent.agentStatusSeen = 0
    await rename(path, `${path}.previous`)
    await mkdir(path)
    await assert.rejects(api('sessions.markSessionSeen', [sessionId]), error => ['EISDIR', 'EPERM', 'ENOTEMPTY'].includes(error.code))
    assert.equal(agent.agentStatusSeen, 0)
    assert.equal(published, 1)
    assert.equal(verified, 2)
  } finally { await rm(root, { recursive: true }) }
})
