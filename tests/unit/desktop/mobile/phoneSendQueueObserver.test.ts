import { beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { startPhoneSendQueueObserver, type PhoneQueueObserverDependencies, type PhoneQueueSource } from '@/mobile/agent-watch/phone-send-queue-observer'

const held = (id = 'held'): SessionInput => ({ id, accountId: 'owner', deviceId: 'host', sessionId: 'session', text: id, createdAt: 1, queued: true, sendQueue: { order: 1 } })
const turn = (done: boolean): TranscriptTurn => ({ id: 'turn', seq: 1, initiator: 'user', items: [], ...(done ? { outcome: { kind: 'done' as const } } : {}) })
let inputs: readonly SessionInput[], current: boolean, available: boolean
let snapshot: Awaited<ReturnType<PhoneQueueSource['read']>>
let changed: () => void, targetChanged: () => void
let deps: PhoneQueueObserverDependencies
const disposeSource = vi.fn(), releaseDirectory = vi.fn(), unsubscribe = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  inputs = []; current = true; available = true; snapshot = { ready: true, turns: [turn(false)] }
  changed = () => {}; targetChanged = () => {}
  deps = {
    current: () => current, inputs: () => inputs, available: () => available,
    subscribe: vi.fn(listener => { changed = listener; return unsubscribe }),
    retainDirectory: vi.fn(() => releaseDirectory),
    observe: vi.fn((_, listener) => { targetChanged = listener; return { read: vi.fn(async () => snapshot), dispose: disposeSource } }),
    release: vi.fn(async () => { inputs = []; changed() }), report: vi.fn(),
  }
})

it('adds no reads or subscriptions on an ordinary session open without composer-held inputs', () => {
  inputs = [{ ...held(), queued: false, sendQueue: undefined }]
  const stop = startPhoneSendQueueObserver('owner', deps)
  expect(deps.observe).not.toHaveBeenCalled()
  expect(deps.retainDirectory).not.toHaveBeenCalled()
  stop()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('continues observing after the page is gone and releases only when its foreground really completes', async () => {
  inputs = [held(), held('second')]
  const stop = startPhoneSendQueueObserver('owner', deps)
  await vi.waitFor(() => expect(deps.observe).toHaveBeenCalledTimes(1))
  expect(deps.release).not.toHaveBeenCalled()
  snapshot = { ready: false, turns: [turn(true)] }; targetChanged()
  await Promise.resolve(); await Promise.resolve()
  expect(deps.release).not.toHaveBeenCalled()
  snapshot = { ready: true, turns: [turn(true)] }; targetChanged()
  await vi.waitFor(() => expect(deps.release).toHaveBeenCalledTimes(1))
  expect(disposeSource).toHaveBeenCalledTimes(1)
  expect(releaseDirectory).toHaveBeenCalledTimes(1)
  stop()
  expect(releaseDirectory).toHaveBeenCalledTimes(1)
})

it('retains directory demand while a host is offline and resumes from current facts on reconnection', async () => {
  inputs = [held()]; available = false
  const stop = startPhoneSendQueueObserver('owner', deps)
  expect(deps.retainDirectory).toHaveBeenCalledTimes(1)
  expect(deps.observe).not.toHaveBeenCalled()
  available = true; snapshot = { ready: true, turns: [turn(true)] }; changed()
  await vi.waitFor(() => expect(deps.release).toHaveBeenCalledTimes(1))
  stop()
})

it.each(['dispose', 'account-change', 'queue-deleted'] as const)('ignores a late idle read after %s', async reason => {
  inputs = [held()]
  let resolve!: (value: typeof snapshot) => void
  deps.observe = (_, listener) => { targetChanged = listener; return { read: () => new Promise(done => { resolve = done }), dispose: disposeSource } }
  const stop = startPhoneSendQueueObserver('owner', deps)
  if (reason === 'dispose') stop()
  else if (reason === 'account-change') { current = false; changed() }
  else { inputs = []; changed() }
  resolve({ ready: true, turns: [turn(true)] })
  await Promise.resolve(); await Promise.resolve()
  expect(deps.release).not.toHaveBeenCalled()
  expect(disposeSource).toHaveBeenCalledTimes(1)
  stop()
})

it('rereads after a newer event arrives during an idle lookup instead of releasing from the older answer', async () => {
  inputs = [held()]
  let resolve!: (value: typeof snapshot) => void
  const read = vi.fn<PhoneQueueSource['read']>().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ ready: true, turns: [turn(false)] })
  deps.observe = (_, listener) => { targetChanged = listener; return { read, dispose: disposeSource } }
  const stop = startPhoneSendQueueObserver('owner', deps)
  targetChanged(); resolve({ ready: true, turns: [turn(true)] })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(deps.release).not.toHaveBeenCalled()
  stop()
})
