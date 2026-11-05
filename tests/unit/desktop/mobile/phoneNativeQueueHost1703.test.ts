// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { NativeSessionRecord, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { SessionInputOutbox, type SessionInput } from '@/lib/sessionInputOutbox'
import { changed, state, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { watchPhoneSessionSendQueues } from '@/mobile/agent-watch/phone-send-queue-host'

const remote = vi.hoisted(() => ({
  snapshot: vi.fn(), native: vi.fn(), life: vi.fn(), report: vi.fn(),
  events: new Map<string, (data: never) => void>(),
  link: (_open: boolean) => {},
  directoryChanged: () => {}, runtime: 'acp' as 'acp' | 'pty' | null,
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessions: { lifeView: remote.life }, sessionTimeline: { sessionNativeRecord: remote.native } }),
  fetchSnapshot: remote.snapshot,
  subscribeSession: async () => {}, unsubscribeSession: async () => {},
  subscribeSessionEvents: () => () => {}, subscribeSessionErrors: () => () => {},
  onLinkChange: (_id: string, listener: typeof remote.link) => { remote.link = listener; return () => {} },
  onMachineEvent: (_id: string, channel: { name: string }, listener: (data: never) => void) => {
    remote.events.set(channel.name, listener); return () => remote.events.delete(channel.name)
  },
}))
vi.mock('@/mobile/local-agent/phoneTimelineClient', () => ({ phoneTimelineClient: {} }))
vi.mock('@/store/devicesCache', () => ({ subscribeCachedDevices: () => () => {} }))
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({
  directoryDevices: () => [{ device_id: 'host', is_online: true, capabilities: {} }],
  liveDeviceSessions: () => ({ host: { cached: false, connected: true, sessions: remote.runtime ? [
    { conversationId: 'session', runtime: remote.runtime, nativeInputVersion: 2 },
  ] : [] } }),
  requestPhoneTaskDirectory: () => () => {}, subscribeDeviceSessions: (listener: () => void) => { remote.directoryChanged = listener; return () => {} },
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: remote.report }) }))

const turn = (id: string, outcome?: TranscriptTurn['outcome']): TranscriptTurn => ({ id, seq: 0, initiator: 'user', items: [], ...(outcome ? { outcome } : {}) })
const record = (turns: TranscriptTurn[], activeTurn: TranscriptTurn | null = null): NativeSessionRecord => ({
  turns, activeTurn, originTurnIds: turns.map(t => t.id), hasNewer: false, latestStoredSeq: turns.at(-1)?.seq ?? -1, nextCursor: null,
})
let rows: Map<string, SessionInput>, outbox: SessionInputOutbox, stop: (() => void) | undefined
const delivered = vi.fn<(input: SessionInput) => Promise<void>>()
beforeEach(() => {
  vi.clearAllMocks(); remote.events.clear(); remote.runtime = 'acp'
  rows = new Map([['first', { id: 'first', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'same', createdAt: 1,
    queued: true, sendQueue: { order: 1 } }]])
  const publish = () => { state().rows = [...rows.values()]; changed() }
  delivered.mockResolvedValue(undefined)
  outbox = new SessionInputOutbox('owner', { list: async () => [...rows.values()], put: async row => { rows.set(row.id, row) },
    remove: async (_, id) => { rows.delete(id) } }, delivered, () => state().valid(), publish)
  Object.assign(state(), { accountId: 'owner', valid: () => true, queue: Promise.resolve(outbox) }); publish()
  remote.life.mockResolvedValue({ kind: 'ready', hold: null })
  remote.snapshot.mockResolvedValue({ cursor: { epoch: 'provider', seq: 1 }, turns: [turn('provider-unsettled')],
    queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false } satisfies TimelineSnapshot)
  remote.native.mockResolvedValue({ ok: true, value: record([turn('native-completed', { kind: 'done', reason: 'end_turn' })]) })
})
afterEach(() => {
  stop?.(); stop = undefined
  Object.assign(state(), { accountId: null, valid: () => false, queue: null, rows: EMPTY }); changed()
})

it('drains the actual persistent outbox without a task page when the provider has no terminal boundary', async () => {
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
  expect(delivered.mock.calls[0][0]).toMatchObject({ id: 'first', queued: false })
  expect(delivered.mock.calls[0][0].steerIfBusy).toBeUndefined()
  expect(remote.report).not.toHaveBeenCalled()
})

it('does not release from an older provider completion while the native foreground is still active', async () => {
  remote.snapshot.mockResolvedValue({ cursor: { epoch: 'provider', seq: 1 }, turns: [turn('old-provider', { kind: 'done' })],
    queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false } satisfies TimelineSnapshot)
  remote.native.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.snapshot).toHaveBeenCalled())
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  expect(rows.get('first')?.sendQueue).toBeDefined()
})

it('releases after native persistence even when the provider emits no completion event', async () => {
  remote.native.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalledTimes(1))
  expect(delivered).not.toHaveBeenCalled()
  remote.native.mockResolvedValue({ ok: true, value: record([turn('current-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'native-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it.each(['cancelled', 'error'] as const)('retains the input after native %s', async kind => {
  remote.native.mockResolvedValue({ ok: true, value: record([turn('current-native', { kind })]) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalled())
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  expect(rows.get('first')?.sendQueue).toBeDefined()
})

it.each(['user-stop', 'start-failed'])('does not bypass Life hold %s with a completed native record', async hold => {
  remote.life.mockResolvedValue({ kind: 'ready', hold })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.life).toHaveBeenCalled())
  await outbox.flush()
  expect(remote.native).not.toHaveBeenCalled()
  expect(delivered).not.toHaveBeenCalled()
})

it('keeps a failed durable writer blocked instead of using an older successful native turn', async () => {
  remote.native.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalledTimes(1))
  remote.native.mockResolvedValue({ ok: true, value: record([turn('old-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'current-source', status: 'failed', cause: { message: 'disk unavailable' } } as never)
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalledTimes(2))
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
})

it.each(['disconnect', 'account-change', 'dispose'] as const)('ignores a late completed native read after %s', async reason => {
  const pending = Promise.withResolvers<unknown>()
  remote.native.mockReturnValueOnce(pending.promise)
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalledTimes(1))
  if (reason === 'disconnect') remote.link(false)
  else if (reason === 'account-change') { state().valid = () => false; changed() }
  else stop()
  pending.resolve({ ok: true, value: record([turn('completed', { kind: 'done' })]) })
  await pending.promise; await Promise.resolve(); await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  expect(rows.get('first')?.sendQueue).toBeDefined()
})

it('requires a completed predecessor identity even when a different input has identical text', async () => {
  rows.set('first', { ...rows.get('first')!, sendQueue: { order: 1, afterInputId: 'expected-client' } })
  const completed = (clientMessageId: string): TranscriptTurn => ({ ...turn('stored', { kind: 'done' }), items: [
    { kind: 'message', role: 'user', seq: 0, id: 'provider-user', text: 'same', _meta: { guguClientMessageId: clientMessageId } },
  ] })
  remote.native.mockResolvedValue({ ok: true, value: record([completed('different-client')]) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.native).toHaveBeenCalledTimes(1))
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  remote.native.mockResolvedValue({ ok: true, value: record([completed('expected-client')]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'expected-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
  expect(delivered.mock.calls[0][0].id).toBe('first')
})

it('does not fall back to an older completed provider record after a native read failure', async () => {
  remote.snapshot.mockResolvedValue({ cursor: { epoch: 'provider', seq: 1 }, turns: [turn('old-provider', { kind: 'done' })],
    queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false } satisfies TimelineSnapshot)
  remote.native.mockResolvedValue({ ok: false, error: { code: 'record_not_found', message: 'Native record unavailable' } })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.report).toHaveBeenCalled())
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  expect(rows.get('first')?.sendQueue).toBeDefined()
})

it('waits for the directory to identify the target before interpreting provider history', async () => {
  remote.runtime = null
  remote.snapshot.mockResolvedValue({ cursor: { epoch: 'provider', seq: 1 }, turns: [turn('old-provider', { kind: 'done' })],
    queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false } satisfies TimelineSnapshot)
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.snapshot).toHaveBeenCalled())
  await outbox.flush()
  expect(delivered).not.toHaveBeenCalled()
  remote.runtime = 'acp'; remote.directoryChanged()
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it('retains the existing provider completion path for a terminal-hosted target', async () => {
  remote.runtime = 'pty'
  remote.snapshot.mockResolvedValue({ cursor: { epoch: 'provider', seq: 1 }, turns: [turn('provider', { kind: 'done' })],
    queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false } satisfies TimelineSnapshot)
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
  expect(remote.native).not.toHaveBeenCalled()
})
