// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { Device } from '@gugu/core/shared/types/chat'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'

const fixture = vi.hoisted(() => ({
  owner: '', platform: 'electron', devices: [] as Device[], turns: [] as TranscriptTurn[], busy: true,
  events: undefined as undefined | ((result: never) => void),
  sent: vi.fn(), fetch: vi.fn(), native: vi.fn(), stopNative: vi.fn(), unsubscribe: vi.fn(),
}))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: fixture.devices, phones: [] }) }))
vi.mock('@/platform', () => ({ platform: { get kind() { return fixture.platform } } }))
vi.mock('@/hooks/useLocalSessionDirectory', () => ({ useLocalSessionDirectory() {} }))
vi.mock('@/components/chat/ChatSummariesHost', () => ({ ChatSummariesHost: () => null }))
vi.mock('@/components/chat/NativeConversationReadHost', () => ({ NativeConversationReadHost: () => null }))
vi.mock('@/store/devicesCache', () => ({ subscribeCachedDevices: () => () => {} }))
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({
  directoryDevices: () => fixture.devices,
  liveDeviceSessions: () => ({ phone: { cached: false, connected: true, sessions: [] } }),
  requestPhoneTaskDirectory: () => () => {}, subscribeDeviceSessions: () => () => {},
}))
vi.mock('@/lib/sessionSendQueueHost', () => ({ watchSessionSendQueues: (...args: unknown[]) => { fixture.native(...args); return fixture.stopNative } }))
vi.mock('@/mobile/local-agent/phoneTimelineClient', () => ({ phoneTimelineClient: {
  fetchSnapshot: async () => { fixture.fetch(); return { turns: fixture.turns, liveReply: fixture.busy ? {} : null, queuedPrompts: [], cursor: null } },
  subscribeSessionEvents: (_device: string, _id: string, cb: typeof fixture.events) => { fixture.events = cb; return () => { fixture.events = undefined } },
  subscribeSessionErrors: () => () => {}, onLinkChange: () => () => {},
  subscribeSession: async () => {}, unsubscribeSession: async () => { fixture.unsubscribe() },
} }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: async (device: string, _channel: string, [request]: unknown[]) => { fixture.sent(device, request); return { accepted: true } } }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSnapshot: vi.fn(), onMachineEvent: vi.fn() }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn() {} }) }))
import { SessionInputOutboxHost } from '@/hooks/useSessionInputOutbox'
import { enqueueSessionInput, state } from '@/lib/sessionInputOutboxBridge'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks(); fixture.owner = crypto.randomUUID(); fixture.platform = 'electron'; fixture.busy = true; fixture.turns = []
  fixture.devices = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] } } as Device]
  fixture.events = undefined; harness = createReactHarness()
})
afterEach(() => harness.cleanup())

it.each(['done', 'cancelled', 'error'] as const)('keeps phone custody in the Electron shell after the task pane closes (%s)', async outcome => {
  // Only the root host is mounted: neither AssistantTaskChatWindow nor a task page can release this input.
  await harness.render(<SessionInputOutboxHost accountId={fixture.owner} />)
  let id = ''
  await act(async () => { id = (await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'after this turn', queued: true, sendQueue: { order: 1 } })).id })
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled())
  expect(fixture.sent).not.toHaveBeenCalled()
  const nativeFilter = fixture.native.mock.calls[0][2] as (input: SessionInput) => boolean
  expect(nativeFilter({ deviceId: 'phone' } as SessionInput)).toBe(false)
  expect(nativeFilter({ deviceId: null } as SessionInput)).toBe(true)
  expect(nativeFilter({ deviceId: 'desktop-host' } as SessionInput)).toBe(true)
  fixture.busy = false
  fixture.turns = [{ id: 'turn', seq: 1, initiator: 'user', items: [], outcome: { kind: outcome } }]
  await act(async () => {
    fixture.events!({ ok: true, batch: { turns: fixture.turns, queuedPrompts: [] } } as never)
    await vi.waitFor(() => expect(fixture.fetch.mock.calls.length).toBeGreaterThan(1))
    await (await state().queue)!.flush()
  })
  if (outcome === 'done') {
    await vi.waitFor(() => expect(fixture.sent).toHaveBeenCalledExactlyOnceWith('phone', expect.objectContaining({ clientRequestId: id, conversationId: 'phone-task' })))
    expect(await (await state().queue)!.list()).toEqual([])
  } else {
    expect(fixture.sent).not.toHaveBeenCalled()
    expect(await (await state().queue)!.list()).toMatchObject([{ id, sendQueue: { order: expect.any(Number) } }])
  }
})

it('preserves the non-Electron observer and does not start the ACP observer there', async () => {
  fixture.platform = 'web'
  await harness.render(<SessionInputOutboxHost accountId={fixture.owner} />)
  await act(async () => { await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'held', queued: true, sendQueue: { order: 1 } }) })
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled())
  expect(fixture.native).not.toHaveBeenCalled()
})

it('does not claim desktop tasks through the phone observer on Electron and disposes both roots', async () => {
  fixture.devices = [{ device_id: 'desktop-host', is_online: true, capabilities: {} } as Device]
  await harness.render(<SessionInputOutboxHost accountId={fixture.owner} />)
  await act(async () => { await enqueueSessionInput({ deviceId: 'desktop-host', sessionId: 'desktop-task', text: 'desktop held', queued: true, sendQueue: { order: 1 } }) })
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect(fixture.sent).not.toHaveBeenCalled()
  await harness.render(null)
  expect(fixture.stopNative).toHaveBeenCalledOnce()
})
