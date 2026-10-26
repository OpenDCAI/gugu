// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionListSyncHandlers } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-list-sync'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { useNeedsYouTasks } from '../../../../apps/desktop/src/components/needsYou/useNeedsYouTasks'

const state = vi.hoisted(() => ({ host: true, devices: [] as unknown[], directory: {} as Record<string, unknown>, handlers: null as SessionListSyncHandlers | null }))
const stop = vi.hoisted(() => vi.fn())
const sync = vi.hoisted(() => vi.fn((_client, device, handlers: SessionListSyncHandlers) => { state.handlers = handlers; return { stop, reconnect: vi.fn() } }))
vi.mock('@/platform', () => ({ platform: { capabilities: { get sessionHost() { return state.host } }, subscribeAppForeground: () => () => undefined } }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: state.devices }) }))
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({ useLiveDeviceSessions: () => state.directory }))
vi.mock('@/session/shared/remote-sessions/session-list-sync', () => ({ startSessionListSync: sync }))
vi.mock('@/session/renderer/features/remote-hosts/machine-session-list', () => ({ machineSessionListClient: {} }))
let harness: ReturnType<typeof createReactHarness>
function Probe() { const { tasks } = useNeedsYouTasks(); return <output>{tasks.map(task => `${task.deviceId}:${task.session.conversationId}`).join(',')}</output> }
const pending = (id: string) => ({ conversationId: id, agentStatus: 'needs_approval', status: { status: 'needs_user', detail: 'approval' } })
beforeEach(() => {
  vi.clearAllMocks()
  state.host = true
  state.devices = [{ device_id: 'desktop', label: 'Desktop', is_current_device: true, is_online: true }, { device_id: 'server', label: 'Server', is_online: true }]
  state.directory = { server: { cached: false, error: null, sessions: [pending('remote')] } }
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())
it('merges its local list with the existing remote directory without subscribing remotely again', async () => {
  await renderWithAppProviders(harness, <Probe />)
  await act(async () => { state.handlers!.onList({ projects: [], sessions: [pending('local')] } as never) })
  expect(harness.container.textContent).toBe('desktop:local,server:remote')
  expect(sync).toHaveBeenCalledTimes(1)
  expect(sync.mock.calls[0]![1]).toBe('local')
})
it('phone reads the existing directory and never starts a second machine list sync', async () => {
  state.host = false
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.textContent).toBe('server:remote')
  expect(sync).not.toHaveBeenCalled()
})
it('does not offer a cached, disconnected, or finished remote request', async () => {
  state.directory = { server: { cached: true, error: null, sessions: [pending('old')] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.textContent).toBe('')
  state.directory = { server: { cached: false, error: null, sessions: [{ ...pending('done'), status: { status: 'working', detail: null } }] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.textContent).toBe('')
})
it('drops the prior account and stops its list subscription on logout', async () => {
  await renderWithAppProviders(harness, <Probe />)
  await act(async () => { state.handlers!.onList({ projects: [], sessions: [pending('local')] } as never) })
  await renderWithAppProviders(harness, <Probe />, { auth: null })
  expect(harness.container.textContent).toBe('')
  expect(stop).toHaveBeenCalledTimes(1)
})
