import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openSessionInputStorage, SessionInputOutbox } from '@/lib/sessionInputOutbox'
import { SessionMachine } from '../../../../packages/session-runtime/src/acp-agents/machine/machine'

const fixture = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; accountId: string; deviceId: string | null; sessionId: string; sendQueue: { order: number } }>,
  valid: true, accountId: 'owner', lifecycle: 'ready', activeTurnId: null as string | null, lastTurnOutcome: 'none', queuedPrompts: [] as unknown[],
  snapshot: null as import('@gugu/session-core/acp/client').SessionState | null,
  hold: null as string | null, lifeKind: 'ready', history: vi.fn(), release: vi.fn(), dispose: vi.fn(), stopLife: vi.fn(),
  rowListeners: new Set<() => void>(), changes: new Set<() => void>(),
  gone: undefined as undefined | ((error: unknown) => void), lifeEvent: undefined as undefined | ((view: { sessionId: string }) => void),
}))
vi.mock('@/lib/sessionInputOutboxBridge', () => ({
  state: () => ({ get rows() { return fixture.rows }, get accountId() { return fixture.accountId }, valid: () => fixture.valid }),
  subscribeSessionInputs: (listener: () => void) => { fixture.rowListeners.add(listener); return () => fixture.rowListeners.delete(listener) },
  releaseQueuedSessionInput: (...args: unknown[]) => fixture.release(...args),
}))
vi.mock('@gugu/session-wire', async importOriginal => ({ ...await importOriginal<typeof import('@gugu/session-wire')>(), ReplicaState: class {
  ready = Promise.resolve()
  current() { return fixture.snapshot ?? { lifecycle: fixture.lifecycle, activeTurnId: fixture.activeTurnId, lastTurnOutcome: fixture.lastTurnOutcome, queuedPrompts: fixture.queuedPrompts } }
  onChange(listener: () => void) { fixture.changes.add(listener) }
  onGone(listener: (error: unknown) => void) { fixture.gone = listener }
  dispose() { fixture.dispose(); fixture.changes.clear() }
} }))
vi.mock('@/session/renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ session: { state: () => ({}) }, getHistory: (...args: unknown[]) => fixture.history(...args) }),
}))
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessions: { lifeView: async () => ({ kind: fixture.lifeKind, hold: fixture.hold }) } }),
  onMachineEvent: (_machine: unknown, _channel: unknown, listener: typeof fixture.lifeEvent) => { fixture.lifeEvent = listener; return fixture.stopLife },
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn() {} }) }))
import { watchSessionSendQueues } from '@/lib/sessionSendQueueHost'

let close: (() => void) | undefined
const emit = () => { for (const listener of fixture.rowListeners) listener() }
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(fixture, { valid: true, accountId: 'owner', lifecycle: 'ready', activeTurnId: null, lastTurnOutcome: 'none', hold: null, lifeKind: 'ready', gone: undefined, lifeEvent: undefined })
  fixture.rows = [{ id: 'held', accountId: 'owner', deviceId: null, sessionId: 'session', sendQueue: { order: 1 } }]
  fixture.snapshot = null
  fixture.queuedPrompts = []
  fixture.history.mockResolvedValue({ success: true, data: { turns: [] } })
  fixture.release.mockResolvedValue(null)
})
afterEach(() => { close?.(); close = undefined; fixture.rowListeners.clear(); fixture.changes.clear() })

it('does not open ACP transport for a target assigned to the phone observer', async () => {
  close = watchSessionSendQueues('owner', () => undefined, () => false)
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.lifeEvent).toBeUndefined()
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
})

it.each([0, 1])('actually sends a busy queued input after a real normal WorkEnded snapshot (background agents=%s)', async background => {
  const machine = new SessionMachine('session')
  machine.apply({ type: 'SessionReady' })
  machine.apply({ type: 'WorkStarted' })
  machine.apply({ type: 'AgentsChanged', runningCount: background })
  fixture.snapshot = machine.sessionState('foreground')
  const storage = await openSessionInputStorage(new IDBFactory())
  const sent: string[] = []
  const queue = new SessionInputOutbox('owner', storage, async input => { sent.push(input.id) }, () => true)
  const input = await queue.enqueue({ sessionId: 'session', deviceId: null, text: 'queued while busy', queued: true, sendQueue: { order: 1 } })
  fixture.rows = [{ ...input, sendQueue: input.sendQueue! }]
  fixture.release.mockImplementation(async (sessionId: string, _turns: unknown, _id: unknown, _steer: unknown, allowed: () => boolean) => {
    const released = await queue.releaseQueued(sessionId, {}, new Set(), undefined, false, allowed)
    await queue.flush()
    return released
  })
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(sent).toEqual([])
  machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } })
  fixture.snapshot = machine.sessionState(null)
  expect(fixture.snapshot).toMatchObject({ lifecycle: 'ready', activeTurnId: null, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' })
  for (const change of fixture.changes) change()
  await expect.poll(() => sent).toEqual([input.id])
  expect(await queue.list()).toEqual([])
})

it.each(['cancelled', 'errored'] as const)('retains the held input after a real %s WorkEnded snapshot', async reason => {
  const machine = new SessionMachine('session')
  machine.apply({ type: 'SessionReady' }); machine.apply({ type: 'WorkStarted' })
  machine.apply({ type: 'WorkEnded', outcome: reason === 'errored' ? { kind: 'errored' } : { kind: 'stopped', stopReason: 'cancelled' } })
  fixture.snapshot = machine.sessionState(null)
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
})

it.each(['user-stop', 'start-failed'])('keeps Life hold %s authoritative over a real normal completion', async hold => {
  const machine = new SessionMachine('session')
  machine.apply({ type: 'SessionReady' }); machine.apply({ type: 'WorkStarted' })
  machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } })
  fixture.snapshot = machine.sessionState(null); fixture.hold = hold
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
})

it('releases in the signed-in shell without any conversation page mounted, then disposes when queue is empty', async () => {
  close = watchSessionSendQueues('owner', () => 'local')
  await expect.poll(() => fixture.release.mock.calls.length).toBe(1)
  const guard = fixture.release.mock.calls[0][4] as () => boolean
  expect(guard()).toBe(true)
  fixture.rows = []; emit()
  expect(fixture.dispose).toHaveBeenCalledOnce()
  expect(fixture.stopLife).toHaveBeenCalledOnce()
  expect(guard()).toBe(false)
})

it.each(['user-stop', 'failed'])('does not automatically restart the queue during Life hold %s', async hold => {
  fixture.hold = hold
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
  fixture.hold = null; fixture.lifeEvent!({ sessionId: 'session' })
  await expect.poll(() => fixture.release.mock.calls.length).toBe(1)
})

it.each([{ lifecycle: 'working' }, { activeTurnId: 'receipt-gap' }, { lastTurnOutcome: 'stopped' }, { lastTurnOutcome: 'errored' }])('waits for the authoritative foreground state %j', async state => {
  Object.assign(fixture, state)
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
})

it('does not release during host restoration even if the older native snapshot still says ready', async () => {
  fixture.lifeKind = 'starting'
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  fixture.lifeKind = 'ready'; fixture.lifeEvent!({ sessionId: 'session' })
  await expect.poll(() => fixture.release.mock.calls.length).toBe(1)
})

it('lets the older host queue drain before sending new local held inputs', async () => {
  fixture.queuedPrompts = [{ id: 'legacy-before-upgrade' }]
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!fixture.lifeEvent).toBe(true)
  expect(fixture.history).not.toHaveBeenCalled()
  fixture.queuedPrompts = []
  for (const change of fixture.changes) change()
  await expect.poll(() => fixture.release.mock.calls.length).toBe(1)
})

it('does not release from an idle snapshot that was invalidated by Stop while history was being read', async () => {
  let finish!: (value: unknown) => void
  fixture.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => !!finish).toBe(true)
  fixture.hold = 'user-stop'; fixture.lifeEvent!({ sessionId: 'session' })
  finish({ success: true, data: { turns: [] } })
  await expect.poll(() => fixture.history.mock.calls.length).toBe(1)
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
})

it('invalidates queued release on logout and can reconnect a gone replica on the next outbox refresh', async () => {
  close = watchSessionSendQueues('owner', () => undefined)
  await expect.poll(() => fixture.release.mock.calls.length).toBe(1)
  const guard = fixture.release.mock.calls[0][4] as () => boolean
  fixture.accountId = 'other'
  expect(guard()).toBe(false)
  fixture.accountId = 'owner'
  fixture.gone!(new Error('disconnected'))
  expect(fixture.dispose).toHaveBeenCalledOnce()
  emit()
  await expect.poll(() => fixture.release.mock.calls.length).toBe(2)
  close(); close = undefined
  expect(guard()).toBe(false)
})
