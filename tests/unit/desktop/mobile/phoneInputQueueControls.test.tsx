// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../../support/testHarness'
import { SessionInputOutbox, type SessionInput } from '@/lib/sessionInputOutbox'
import { state, changed, EMPTY, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { usePhoneInputQueue } from '@/mobile/agent-watch/use-phone-input-queue'
import { phoneQueueReady } from '@/mobile/agent-watch/phone-input-queue'

const { cancel, remote, snapshot } = vi.hoisted(() => ({ cancel: vi.fn(async () => ({ cancelled: true })), remote: vi.fn(async () => null), snapshot: vi.fn() }))
vi.mock('@/components/assistant/assistantTimelineClient', () => ({ assistantTimelineClient: () => ({ cancelSessionTurn: cancel }), changeConversationQueue: remote }))
vi.mock('@/mobile/local-agent/phoneTimelineClient', () => ({ phoneTimelineClient: { cancelSessionTurn: cancel, fetchSnapshot: snapshot } }))
vi.mock('@renderer/features/sessions/acp/send-queued-prompt-now-flow', () => ({ requestSendQueuedPromptNow: ({ send }: { send(): void }) => send() }))

const target = { deviceId: 'host', sessionId: 'session', local: false }
const held = (id: string, order: number): SessionInput => ({ id, text: id, createdAt: order, accountId: 'owner', ...target, queued: true, sendQueue: { order } })
let harness: ReturnType<typeof createReactHarness>
let queue: ReturnType<typeof usePhoneInputQueue>
let rows: Map<string, SessionInput>
let outbox: SessionInputOutbox
let deliver: ReturnType<typeof vi.fn<(input: SessionInput) => Promise<void>>>

function Host({ ready = false, working = true, turns = [], life = { kind: 'ready', hold: null }, phoneHost = false, hosted = [], steers = false }: {
  ready?: boolean; working?: boolean; turns?: readonly TranscriptTurn[]; life?: Parameters<typeof phoneQueueReady>[2]; phoneHost?: boolean
  hosted?: { id: string; text: string; clientMessageId?: string }[]; steers?: boolean
}) {
  queue = usePhoneInputQueue({ ...target, phoneHost }, useQueuedSessionInputs('session'), hosted, turns, working, false, phoneQueueReady(ready, phoneHost, life), steers)
  return createElement('div', null, queue.error)
}
const render = (props: Parameters<typeof Host>[0] = {}) => harness.render(createElement(Host, props))
const read = (id: string) => rows.get(id)!

beforeEach(() => {
  harness = createReactHarness()
  rows = new Map([['first', held('first', 1)], ['second', held('second', 2)]])
  deliver = vi.fn(async () => {})
  const publish = () => { state().rows = [...rows.values()]; changed() }
  outbox = new SessionInputOutbox('owner', {
    list: async () => [...rows.values()], put: async input => { rows.set(input.id, input) }, remove: async (_, id) => { rows.delete(id) },
  }, deliver, () => true, publish)
  Object.assign(state(), { accountId: 'owner', valid: () => true, queue: Promise.resolve(outbox) })
  publish()
})
afterEach(() => {
  harness.cleanup(); vi.useRealTimers(); cancel.mockReset(); cancel.mockResolvedValue({ cancelled: true }); remote.mockClear(); snapshot.mockReset()
  Object.assign(state(), { accountId: null, valid: () => false, queue: null, rows: EMPTY }); changed()
})

it('exposes all controls on the first local queue frame and edits in place without losing attachments', async () => {
  vi.useFakeTimers()
  read('first').files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }]
  await render()
  expect(queue.props.queuedPrompts.map(prompt => [prompt.id, prompt.locked])).toEqual([['first', undefined], ['second', undefined]])
  await act(async () => { queue.props.onBeginEditQueuedPrompt('first', 'normal unsent draft') })
  expect(read('first').sendQueue?.edit).toEqual({ draftText: 'first', originalDraftText: 'normal unsent draft' })
  await act(async () => { queue.props.onChangeQueuedPromptEdit('changed in main editor'); await vi.advanceTimersByTimeAsync(301) })
  expect(read('first').sendQueue?.edit?.draftText).toBe('changed in main editor')
  await act(async () => { queue.props.onFinishQueuedPromptEdit('changed in main editor') })
  expect(read('first').text).toBe('changed in main editor')
  expect(read('first').sendQueue?.edit).toBeUndefined()
  expect(read('first').files?.[0]?.itemId).toBe('file')
  expect(deliver).not.toHaveBeenCalled()
  expect(remote).not.toHaveBeenCalled()
})

it('deletes and reorders the durable local queue without contacting a busy host', async () => {
  await render()
  await act(async () => { queue.props.onReorderQueuedPrompts(['second', 'first']) })
  expect(queue.props.queuedPrompts.map(prompt => prompt.id)).toEqual(['second', 'first'])
  await act(async () => { queue.props.onDeleteQueuedPrompt('second') })
  expect(queue.props.queuedPrompts.map(prompt => prompt.id)).toEqual(['first'])
  expect(rows.has('second')).toBe(false)
  expect(deliver).not.toHaveBeenCalled()
  expect(remote).not.toHaveBeenCalled()
})

it('releases one input per completed foreground turn and waits for that input before releasing the next', async () => {
  await render({ ready: true, working: true })
  expect(deliver).not.toHaveBeenCalled()
  await render({ ready: false, working: false })
  expect(deliver).not.toHaveBeenCalled()
  await render({ ready: true, working: false })
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  expect(deliver.mock.calls[0]?.[0].id).toBe('first')
  expect(read('second').sendQueue?.afterInputId).toBe('first')
  await render({ ready: true, working: false, turns: [] })
  expect(deliver).toHaveBeenCalledTimes(1)
  const completed: TranscriptTurn = { id: 'native-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', role: 'user', id: 'native-user', seq: 0, text: 'first', _meta: { guguClientMessageId: 'first' } },
  ] }
  await render({ ready: true, working: false, turns: [completed] })
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  expect(deliver.mock.calls[1]?.[0].id).toBe('second')
})

it('does not drain an input while its main-composer edit is reserved', async () => {
  await render()
  await act(async () => { queue.props.onBeginEditQueuedPrompt('first', 'normal draft') })
  await render({ ready: true, working: false })
  expect(deliver).not.toHaveBeenCalled()
  expect(read('first').sendQueue?.edit?.originalDraftText).toBe('normal draft')
})

it('waits for life after history and does not restart a late user-stopped session', async () => {
  const turns: TranscriptTurn[] = [{ id: 'old-completed-history', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [] }]
  await render({ ready: true, working: false, turns, life: null })
  expect(deliver).not.toHaveBeenCalled()
  await render({ ready: true, working: false, turns, life: { kind: 'ready', hold: 'user-stop' } })
  expect(deliver).not.toHaveBeenCalled()
  expect(read('first').sendQueue).toBeDefined()
  await render({ ready: true, working: false, turns, life: { kind: 'ready', hold: null } })
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
})

it('rechecks a stop arriving while a durable release waits for the storage lane', async () => {
  let unlock!: () => void
  const gate = new Promise<void>(done => { unlock = done })
  const original = outbox.releaseQueued.bind(outbox)
  const waiting = vi.spyOn(outbox, 'releaseQueued').mockImplementationOnce(async (...args) => { await gate; return original(...args) })
  await render({ ready: true, working: false })
  await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(1))
  await render({ ready: true, working: false, life: { kind: 'ready', hold: 'user-stop' } })
  await act(async () => { unlock(); await gate })
  expect(deliver).not.toHaveBeenCalled()
  expect(read('first').sendQueue).toBeDefined()
})

it('keeps an immediate-send input held if cancellation fails, then uses the same durable identity on success', async () => {
  await render()
  cancel.mockRejectedValueOnce(new Error('host refused cancellation'))
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  expect(queue.error).toContain('host refused cancellation')
  expect(read('second').sendQueue).toBeDefined()
  expect(deliver).not.toHaveBeenCalled()
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  expect(deliver.mock.calls[0]?.[0].id).toBe('second')
  expect(read('first').sendQueue?.afterInputId).toBe('second')
})

it('waits for all old host queue entries to drain before automatically releasing a local item', async () => {
  await render({ ready: true, working: false, hosted: [{ id: 'old-host', text: 'older queue' }] })
  expect(deliver).not.toHaveBeenCalled()
  await render({ ready: true, working: false })
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
})

it('uses the exact Pi hosted job to send now without cancelling other already-sent jobs', async () => {
  snapshot.mockResolvedValue({ queuedPrompts: [{ id: 'other', text: 'older' }, { id: 'pi-job-2', clientMessageId: 'second', text: 'second' }], turns: [] })
  await render({ phoneHost: true })
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1))
  expect(cancel).not.toHaveBeenCalled()
  expect(remote).toHaveBeenCalledWith(false, 'host', 'session', { kind: 'send-now', id: 'pi-job-2', steers: false }, true)
  expect(read('first').sendQueue?.afterInputId).toBe('second')
})

it('does not interrupt Pi when that exact input already has a native echo', async () => {
  snapshot.mockResolvedValue({ queuedPrompts: [], turns: [{ items: [{ kind: 'message', role: 'user', _meta: { guguClientMessageId: 'second' } }] }] })
  await render({ phoneHost: true })
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
  expect(cancel).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
  expect(queue.error).toBeNull()
})

it('retains a failed Pi admission with its real error and does not interrupt any job', async () => {
  deliver.mockRejectedValue(new Error('host rejected admission'))
  await render({ phoneHost: true })
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  await vi.waitFor(() => expect(queue.error).toContain('host rejected admission'))
  expect(read('second').failure).toEqual({ code: 'send-failed', message: 'host rejected admission' })
  expect(cancel).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
})

it('keeps an unsupported insertion held instead of silently sending it as an ordinary input', async () => {
  await render({ steers: true })
  await act(async () => { queue.props.onSendQueuedPromptNow('second') })
  await vi.waitFor(() => expect(queue.error).not.toBeNull())
  expect(read('second').sendQueue).toBeDefined()
  expect(deliver).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})
