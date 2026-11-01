import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPhoneTaskApi } from './phone-agent-task-api.mjs'

test('a missing queued file keeps its caption and failure line, acknowledges the count and permits following text', async () => {
  const store = { state: { jobs: {} } }
  const agent = { sessionId: randomUUID(), agentUserId: randomUUID() }
  const inputs = []
  let resolutions = 0
  const api = createPhoneTaskApi({ ownerId: randomUUID(), store, findSession: () => agent, verifyAgent: async () => {},
    turnFiles: async () => { resolutions++; return { text: '[File not saved: File is no longer available]', failedFiles: 1 } },
    admit: async input => { if (!store.state.jobs[input.id]) { store.state.jobs[input.id] = input; inputs.push(input) } },
  })
  const input = { conversationId: agent.sessionId, text: 'original caption', clientRequestId: randomUUID(), files: [{ itemId: randomUUID(), version: 1 }] }
  const first = await api('sessionTimeline.sessionSend', [input], randomUUID())
  assert.equal(first.value.failedFiles, 1)
  assert.equal(inputs[0].prompt, 'original caption\n\n[File not saved: File is no longer available]')
  assert.deepEqual(await api('sessionTimeline.sessionSend', [input], randomUUID()), first)
  assert.equal(resolutions, 1)
  await api('sessionTimeline.sessionSend', [{ conversationId: agent.sessionId, text: 'following text', clientRequestId: randomUUID() }], randomUUID())
  assert.equal(inputs[1].prompt, 'following text')
})
