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
  sent: vi.fn(), fetch: vi.fn(), directoryFetch: vi.fn(), native: vi.fn(), stopNative: vi.fn(), unsubscribe: vi.fn(),
}))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: fixture.devices, phones: [] }) }))
vi.mock('@/platform', () => ({ platform: { get kind() { return fixture.platform } } }))
vi.mock('@/hooks/useLocalSessionDirectory', () => ({ useLocalSessionDirectory() {} }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => false }))
vi.mock('@/hooks/useRemoteHostsBridge', () => ({ useRemoteHostsBridge() {} }))
vi.mock('@/components/SshLinkSignIn', () => ({ SshLinkSignIn: () => null }))
vi.mock('@/components/RemoteFolderPicker', () => ({ RemoteFolderPicker: () => null }))
vi.mock('@/store/auth', async original => ({ ...await original<typeof import('@/store/auth')>(), useAuth: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/lib/supabase', () => ({ getCurrentAuthUserId: async () => fixture.owner }))
vi.mock('@/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => false }))
vi.mock('@/session/shared/remote-sessions/session-list-cache', () => ({ readCachedSessionList: async () => null, writeCachedSessionList() {} }))
vi.mock('@/components/chat/ChatSummariesHost', () => ({ ChatSummariesHost: () => null }))
vi.mock('@/components/chat/NativeConversationReadHost', () => ({ NativeConversationReadHost: () => null }))
vi.mock('@/store/devicesCache', () => ({ subscribeCachedDevices: () => () => {} }))
vi.mock('@/lib/sessionSendQueueHost', () => ({ watchSessionSendQueues: (...args: unknown[]) => { fixture.native(...args); return fixture.stopNative } }))
vi.mock('@/mobile/local-agent/phoneTimelineClient', () => ({ phoneTimelineClient: {
  fetchSnapshot: async () => { fixture.fetch(); return { turns: fixture.turns, liveReply: fixture.busy ? {} : null, queuedPrompts: [], settlements: [], cursor: null } },
  subscribeSessionEvents: (_device: string, _id: string, cb: typeof fixture.events) => { fixture.events = cb; return () => { fixture.events = undefined } },
  subscribeSessionErrors: () => () => {}, onLinkChange: () => () => {},
  subscribeSession: async () => {}, unsubscribeSession: async () => { fixture.unsubscribe() },
} }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: async (device: string, _channel: string, [request]: unknown[]) => { fixture.sent(device, request); return { accepted: true } } }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSnapshot: vi.fn(), onMachineEvent: vi.fn(), fetchPhoneSessions: (device: string) => fixture.directoryFetch(device) }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn() {} }) }))
import { SessionInputOutboxHost } from '@/hooks/useSessionInputOutbox'
import { enqueueSessionInput, state } from '@/lib/sessionInputOutboxBridge'
import { RemoteMachinesHost } from '@/components/sessionpage/RemoteMachinesHost'
import { liveDeviceSessions, phoneTaskDirectoryRequested, publishDirectoryDevices, retainDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

// Mount the actual demand reader, sync hook and queue observer. Only transport replies are substituted.
const root = () => <><RemoteMachinesHost enabled openSettingsSection={() => {}} /><SessionInputOutboxHost accountId={fixture.owner} /></>

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks(); fixture.owner = crypto.randomUUID(); fixture.platform = 'electron'; fixture.busy = true; fixture.turns = []
  fixture.devices = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] } } as Device]
  fixture.directoryFetch.mockReset().mockResolvedValue({ projects: [], sessions: [] })
  retainDeviceSessions([]); publishDirectoryDevices(fixture.devices)
  fixture.events = undefined; harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); retainDeviceSessions([]); publishDirectoryDevices([]); expect(phoneTaskDirectoryRequested()).toBe(false) })

it.each((['electron', 'web'] as const).flatMap(platform => (['done', 'cancelled', 'error'] as const).map(outcome => ({ platform, outcome }))))('keeps phone custody after the task pane closes ($platform / $outcome)', async ({ platform, outcome }) => {
  fixture.platform = platform
  // Only the root host is mounted: neither AssistantTaskChatWindow nor a task page can release this input.
  expect(liveDeviceSessions().phone).toBeUndefined()
  await harness.render(root())
  let id = ''
  await act(async () => { id = (await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'after this turn', queued: true, sendQueue: { order: 1 } })).id })
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled())
  expect(fixture.directoryFetch).toHaveBeenCalledExactlyOnceWith('phone')
  expect(liveDeviceSessions().phone).toMatchObject({ cached: false, connected: true })
  expect(fixture.sent).not.toHaveBeenCalled()
  if (platform === 'electron') {
    const nativeFilter = fixture.native.mock.calls[0][2] as (input: SessionInput) => boolean
    expect(nativeFilter({ deviceId: 'phone' } as SessionInput)).toBe(false)
    expect(nativeFilter({ deviceId: null } as SessionInput)).toBe(true)
    expect(nativeFilter({ deviceId: 'desktop-host' } as SessionInput)).toBe(true)
  } else expect(fixture.native).not.toHaveBeenCalled()
  fixture.busy = false
  fixture.turns = [{ id: 'turn', seq: 1, initiator: 'user', items: [], outcome: { kind: outcome } }]
  await act(async () => {
    fixture.events!({ ok: true, batch: { turns: fixture.turns, queuedPrompts: [], settlements: [] } } as never)
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

it.each(['electron', 'web'])('waits for a real directory reply before reading a timeline (%s)', async platform => {
  fixture.platform = platform
  let reply!: (value: { projects: []; sessions: [] }) => void
  fixture.directoryFetch.mockReturnValue(new Promise(resolve => { reply = resolve }))
  await harness.render(root())
  await act(async () => { await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'held', queued: true, sendQueue: { order: 1 } }) })
  await vi.waitFor(() => expect(fixture.directoryFetch).toHaveBeenCalled())
  expect(liveDeviceSessions().phone).toMatchObject({ cached: true, connected: false })
  expect(fixture.fetch).not.toHaveBeenCalled()
  await act(async () => { reply({ projects: [], sessions: [] }) })
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled())
  expect(fixture.sent).not.toHaveBeenCalled()
})

it.each(['electron', 'web'])('ignores a directory reply after the signed-in shell unmounts (%s)', async platform => {
  fixture.platform = platform
  let reply!: (value: { projects: []; sessions: [] }) => void
  fixture.directoryFetch.mockReturnValue(new Promise(resolve => { reply = resolve }))
  await harness.render(root())
  await act(async () => { await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'held', queued: true, sendQueue: { order: 1 } }) })
  await vi.waitFor(() => expect(fixture.directoryFetch).toHaveBeenCalled())
  await harness.render(null)
  await act(async () => { reply({ projects: [], sessions: [] }) })
  expect(liveDeviceSessions().phone).toMatchObject({ cached: true, connected: false })
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect(fixture.sent).not.toHaveBeenCalled()
})

it('does not claim desktop tasks through the phone observer on Electron and disposes both roots', async () => {
  fixture.devices = [{ device_id: 'desktop-host', is_online: true, capabilities: {} } as Device]
  publishDirectoryDevices(fixture.devices)
  await harness.render(root())
  await act(async () => { await enqueueSessionInput({ deviceId: 'desktop-host', sessionId: 'desktop-task', text: 'desktop held', queued: true, sendQueue: { order: 1 } }) })
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect(fixture.sent).not.toHaveBeenCalled()
  await harness.render(null)
  expect(fixture.stopNative).toHaveBeenCalledOnce()
})
