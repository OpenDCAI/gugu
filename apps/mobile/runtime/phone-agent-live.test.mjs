import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPhoneLiveProjection, createPhonePiObserver } from './phone-agent-live.mjs'
import { toolCallStart, toolCallResult } from '../../../packages/session-core/src/session-record/sources/shared.ts'

test('real text deltas retain the same shared entry keys and message ID when authoritative Pi text arrives', () => {
  const live = createPhoneLiveProjection()
  const agent = { sessionId: randomUUID(), contextEpoch: randomUUID() }
  const job = { id: randomUUID(), contextEpoch: agent.contextEpoch, status: 'running' }
  live.accept(agent, job, { kind: 'message', id: 'live-message', at: 10 })
  live.accept(agent, job, { kind: 'delta', id: 'live-message', index: 0, textKind: 'text', text: '实时' })
  live.accept(agent, job, { kind: 'delta', id: 'live-message', index: 0, textKind: 'text', text: '回答' })
  const streaming = live.project(agent, []).pending
  assert.equal(streaming.map((entry) => entry.event.text).join(''), '实时回答')
  assert.ok(streaming.every((entry) => entry.event.kind === 'message' && !('update' in entry)))
  live.accept(agent, job, { kind: 'complete', id: 'live-message', at: 10, content: [{ type: 'text', text: '实时回答' }] })
  live.accept(agent, job, { kind: 'committed', id: 'live-message', recordId: 'provider-message' })
  const raw = [{ key: 'pi:provider-message#0', at: 10, event: { kind: 'message', role: 'assistant', messageId: 'pi:provider-message#0', text: '实时回答' } }]
  const persisted = live.project(agent, raw)
  assert.deepEqual(persisted.base, streaming)
  assert.deepEqual(persisted.pending, [])
  live.finish(agent, job)
  assert.deepEqual(live.project(agent, raw).base, streaming)
  live.reset(agent.sessionId)
  assert.deepEqual(live.project(agent, raw).base, raw)
})

test('tool declarations/results use the actual tool ID and disk handoff does not repeat output or images', () => {
  const live = createPhoneLiveProjection()
  const agent = { sessionId: randomUUID(), contextEpoch: randomUUID() }
  const job = { id: randomUUID(), contextEpoch: agent.contextEpoch, status: 'running' }
  live.accept(agent, job, { kind: 'message', id: 'tool-message', at: 10 })
  live.accept(agent, job, { kind: 'complete', id: 'tool-message', at: 10, content: [{ type: 'toolCall', id: 'actual-tool', name: 'phone_call', arguments: { name: 'calendar.events.list', args: {} } }] })
  live.accept(agent, job, { kind: 'tool', toolCallId: 'actual-tool', name: 'phone_call', args: {}, at: 11 })
  live.accept(agent, job, { kind: 'committed', id: 'tool-message', recordId: 'a1' })
  live.accept(agent, job, { kind: 'result', id: 'tool-result', toolCallId: 'actual-tool', at: 12, content: [{ type: 'text', text: '真实结果' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }], isError: false })
  live.accept(agent, job, { kind: 'committed', id: 'tool-result', recordId: 'r1' })
  const first = live.project(agent, []).pending
  assert.equal(first.filter((entry) => entry.event.kind === 'tool_call').length, 1)
  const raw = [
    { key: 'pi:a1#0', at: 10, event: toolCallStart('actual-tool', 'phone_call', 'other', { name: 'calendar.events.list', args: {} }) },
    { key: 'pi:r1#0', at: 12, event: toolCallResult('actual-tool', 'completed', { text: '真实结果', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] }) },
  ]
  const persisted = live.project(agent, raw)
  assert.deepEqual(persisted.pending, [])
  assert.equal(persisted.base[0].key, first.find((entry) => entry.event.kind === 'tool_call').key)
  assert.equal(persisted.base[1].key, first.find((entry) => entry.event.kind === 'tool_update').key)
  assert.equal(persisted.base[1].event.toolCallId, 'actual-tool')
  assert.deepEqual(persisted.base[1].event.images, first.find((entry) => entry.event.kind === 'tool_update').event.images)
})

test('SDK observation resolves commit by message identity and emits only safe retry/compaction metadata', async () => {
  const events = []
  let leaf = null
  const observe = createPhonePiObserver({ jobId: randomUUID(), sessionManager: { getLeafEntry: () => leaf, getEntries: () => leaf ? [leaf] : [] }, emit: (event) => events.push(event) })
  const assistant = { role: 'assistant', timestamp: 12, content: [{ type: 'text', text: '实际 SDK 内容' }] }
  observe({ type: 'message_start', message: assistant })
  observe({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '实际 SDK 内容' } })
  observe({ type: 'message_end', message: assistant })
  leaf = { type: 'message', id: 'actual-source-entry', message: assistant }
  await Promise.resolve()
  assert.equal(events.find((event) => event.kind === 'committed').recordId, 'actual-source-entry')
  observe({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'private-provider-error-body' })
  observe({ type: 'compaction_start', reason: 'overflow' })
  observe({ type: 'compaction_end', result: { summary: 'private-context-summary' }, aborted: false, willRetry: true })
  const notices = events.filter((event) => event.type === 'runtime_notice')
  assert.deepEqual(notices.map((event) => event.code), ['retry_start', 'compaction_start', 'compaction_end'])
  assert.equal(JSON.stringify(notices).includes('private-provider-error-body'), false)
  assert.equal(JSON.stringify(notices).includes('private-context-summary'), false)
})

test('cancel/context rotation discards uncommitted drafts and late events cannot revive a completed job', () => {
  const live = createPhoneLiveProjection()
  const agent = { sessionId: randomUUID(), contextEpoch: randomUUID() }
  const job = { id: randomUUID(), contextEpoch: agent.contextEpoch, status: 'running' }
  live.accept(agent, job, { kind: 'message', id: 'cancelled-draft', at: 10 })
  live.accept(agent, job, { kind: 'delta', id: 'cancelled-draft', index: 0, textKind: 'text', text: '未落盘的半句' })
  assert.equal(live.project(agent, []).pending.length, 1)
  job.status = 'cancelled'
  live.finish(agent, job)
  live.accept(agent, job, { kind: 'message', id: 'late', at: 11 })
  assert.deepEqual(live.project(agent, []).pending, [])
  agent.contextEpoch = randomUUID()
  assert.deepEqual(live.project(agent, []).pending, [])
})
