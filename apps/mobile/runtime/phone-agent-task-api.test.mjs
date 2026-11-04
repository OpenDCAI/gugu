import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPhoneTaskApi } from './phone-agent-task-api.mjs'

test('admission retains raw caption and files without resolving bytes, permits replay and following text', async () => {
  const store = { state: { jobs: {} }, save: async () => {} }
  const agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  const inputs = []
  let resolutions = 0
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent, verifyAgent: async () => {},
    turnFiles: async () => { resolutions++; return { text: '[File not saved: File is no longer available]' } },
    admit: async input => { if (!store.state.jobs[input.id]) { store.state.jobs[input.id] = input; inputs.push(input) } },
  })
  const input = { conversationId: agent.sessionId, text: 'original caption', clientRequestId: randomUUID(), files: [{ itemId: randomUUID(), version: 1 }] }
  const first = await api('sessionTimeline.sessionSend', [input], randomUUID())
  assert.deepEqual(Object.keys(first.value).sort(), ['accepted', 'admission', 'messageId'])
  assert.equal(inputs[0].prompt, 'original caption')
  assert.deepEqual(inputs[0].files, input.files)
  assert.equal(inputs[0].clientMessageId, input.clientRequestId)
  assert.deepEqual(await api('sessionTimeline.sessionSend', [input], randomUUID()), first)
  assert.equal(resolutions, 0)
  await api('sessionTimeline.sessionSend', [{ conversationId: agent.sessionId, text: 'following text', clientRequestId: randomUUID() }], randomUUID())
  assert.equal(inputs[1].prompt, 'following text')
})


test('only the authoritative refusal stops recovery; a save failure remains uncertain and replay keeps one job', async () => {
  const store = { state: { jobs: {} }, save: async () => { if (!saved) throw new Error('save still unavailable') } }
  const agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  let saved = false
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent, verifyAgent: async () => {},
    admit: async input => {
      store.state.jobs[input.id] ??= input
      if (!saved) throw Object.assign(new Error('permission denied while saving'), { code: 'not_granted' })
    },
  })
  await assert.rejects(api('sessionTimeline.sessionSend', [{ conversationId: agent.sessionId, text: '' }], randomUUID()), { admission: 'rejected' })
  const input = { conversationId: agent.sessionId, text: 'keep the same input', clientRequestId: randomUUID() }
  await assert.rejects(api('sessionTimeline.sessionSend', [input], randomUUID()), error => error.admission === undefined && error.code === 'not_granted')
  saved = true
  const reply = await api('sessionTimeline.sessionSend', [input], randomUUID())
  assert.equal(reply.value.admission, 'accepted')
  assert.equal(Object.keys(store.state.jobs).length, 1)
  assert.equal(store.state.jobs[reply.value.messageId].prompt, input.text)
})

test('a lost admission ACK retains custody after permission revocation and a duplicate joins the pending admission', async () => {
  const store = { state: { jobs: {} }, save: async () => {} }
  const agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  let finishVerification, denied = false, verifications = 0, admissions = 0
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent,
    verifyAgent: async () => {
      verifications++
      if (denied) throw Object.assign(new Error('permission revoked'), { admission: 'rejected' })
      await new Promise(resolve => { finishVerification = resolve })
    },
    admit: async input => { admissions++; store.state.jobs[input.id] = input },
  })
  const input = { conversationId: agent.sessionId, text: 'keep custody', clientRequestId: randomUUID() }
  const first = api('sessionTimeline.sessionSend', [input], randomUUID())
  denied = true
  const duplicate = api('sessionTimeline.sessionSend', [input], randomUUID())
  finishVerification()
  const accepted = await first
  assert.deepEqual(await duplicate, accepted)
  assert.deepEqual(await api('sessionTimeline.sessionSend', [input], randomUUID()), accepted)
  assert.equal(verifications, 1)
  assert.equal(admissions, 1)
  assert.equal(Object.keys(store.state.jobs).length, 1)
  await assert.rejects(api('sessionTimeline.sessionSend', [{ ...input, text: 'different input' }], randomUUID()), { admission: 'uncertain' })
  await assert.rejects(api('sessionTimeline.sessionSend', [{ ...input, clientRequestId: randomUUID() }], randomUUID()), { admission: 'rejected' })
})

test('unsupported steering is rejected before admission instead of becoming an ordinary queued task', async () => {
  const store = { state: { jobs: {} } }, agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  let admissions = 0
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent, verifyAgent: async () => {}, admit: async () => { admissions++ } })
  await assert.rejects(api('sessionTimeline.sessionSend', [{ conversationId: agent.sessionId, text: 'steer now', steerIfBusy: true, clientRequestId: randomUUID() }], randomUUID()), error => error.code === 'unsupported')
  assert.equal(admissions, 0)
  assert.deepEqual(store.state.jobs, {})
})
