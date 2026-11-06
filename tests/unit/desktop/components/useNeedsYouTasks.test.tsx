// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionListSyncHandlers } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-list-sync'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { markNeedsYouTaskSeen, useNeedsYouTasks } from '../../../../apps/desktop/src/components/needsYou/useNeedsYouTasks'

const state = vi.hoisted(() => ({ host: true, devices: [] as unknown[], directory: {} as Record<string, unknown>, handlers: null as SessionListSyncHandlers | null }))
const stop = vi.hoisted(() => vi.fn())
const markSeen = vi.hoisted(() => vi.fn(async (_id: string) => undefined))
const machineRpc = vi.hoisted(() => vi.fn((_deviceId: string, _local: boolean) => ({ sessions: { markSessionSeen: markSeen } })))
const invokePhoneHost = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost }))
const sync = vi.hoisted(() => vi.fn((_client, device, handlers: SessionListSyncHandlers) => { state.handlers = handlers; return { stop, reconnect: vi.fn() } }))
vi.mock('@/platform', () => ({ platform: { capabilities: { get sessionHost() { return state.host } }, subscribeAppForeground: () => () => undefined } }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: state.devices }) }))
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({ useLiveDeviceSessions: () => state.directory }))
vi.mock('@/session/shared/remote-sessions/session-list-sync', () => ({ startSessionListSync: sync }))
vi.mock('@/session/renderer/features/remote-hosts/machine-session-list', () => ({ machineSessionListClient: {} }))
let harness: ReturnType<typeof createReactHarness>
function Probe() { const { tasks, count, attention } = useNeedsYouTasks(); return <output data-attention={attention} data-count={count} data-phone-hosts={tasks.filter(task => task.phoneHost).map(task => task.deviceId).join(',')}>{tasks.map(task => `${task.deviceId}:${task.session.conversationId}`).join(',')}</output> }
const pending = (id: string) => ({ conversationId: id, agentStatus: 'needs_approval', status: { status: 'needs_user', detail: 'approval' } })
const failure = (id: string, extra: object = {}) => ({ ...pending(id), status: { status: 'error', detail: null }, unseen: true, ...extra })
beforeEach(() => {
  vi.clearAllMocks()
  state.host = true
  state.devices = [{ device_id: 'desktop', label: 'Desktop', capabilities: {}, is_current_device: true, is_online: true }, { device_id: 'server', label: 'Server', capabilities: {}, is_online: true }]
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

it('lists failures, adds a real wait, and keeps the failure after that wait is answered (#1165)', async () => {
  state.directory = { server: { cached: false, error: null, sessions: [failure('failed')] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.querySelector('output')?.dataset.attention).toBe('error')
  expect(harness.container.textContent).toBe('server:failed')
  await act(async () => { state.handlers!.onList({ projects: [], sessions: [pending('local')] } as never) })
  expect(harness.container.querySelector('output')?.dataset.attention).toBe('needs_user')
  expect(harness.container.textContent).toBe('desktop:local,server:failed')
  await act(async () => { state.handlers!.onList({ projects: [], sessions: [] } as never) })
  expect(harness.container.querySelector('output')?.dataset.attention).toBe('error')
  expect(harness.container.textContent).toBe('server:failed')
  expect(sync).toHaveBeenCalledTimes(1)
})
it('preserves native phone host identity from the existing device directory', async () => {
  state.host = false
  state.devices = [{ device_id: 'phone', label: 'Android', is_online: true, capabilities: { host_kind: 'phone' } }]
  state.directory = { phone: { cached: false, error: null, sessions: [pending('native')] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.querySelector('output')?.dataset.phoneHosts).toBe('phone')
  expect(harness.container.textContent).toBe('phone:native')
  expect(sync).not.toHaveBeenCalled()
})

it('acknowledged errors (and errors from hosts without a read bit) stay listed but leave the count and attention; waits count whatever their read bit', async () => {
  state.directory = { server: { cached: false, error: null, sessions: [
    { ...pending('read-failure'), status: { status: 'error', detail: null }, unseen: false },
    { ...pending('unknown-read-failure'), status: { status: 'error', detail: null } },
    { ...pending('approval'), unseen: false },
  ] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.textContent).toBe('server:read-failure,server:unknown-read-failure,server:approval')
  expect(harness.container.querySelector('output')?.dataset.count).toBe('1')
  expect(harness.container.querySelector('output')?.dataset.attention).toBe('needs_user')
  state.directory = { server: { cached: false, error: null, sessions: [{ ...pending('read-failure'), status: { status: 'error', detail: null }, unseen: false }] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.textContent).toBe('server:read-failure')
  expect(harness.container.querySelector('output')?.dataset.count).toBe('0')
  expect(harness.container.querySelector('output')?.dataset.attention).toBeUndefined()
})

it.each([false, true])('uses the existing task host seen action with an explicit destination (local=%s)', async local => {
  await markNeedsYouTaskSeen({ deviceId: 'target', machine: 'Target', local, phoneHost: false, session: { conversationId: 'failure' } } as never)
  expect(machineRpc).toHaveBeenCalledWith('target', local)
  expect(markSeen).toHaveBeenCalledExactlyOnceWith('failure')
  expect(invokePhoneHost).not.toHaveBeenCalled()
})

it('uses the phone host route and propagates its error without acknowledging a task locally', async () => {
  invokePhoneHost.mockRejectedValueOnce(new Error('unknown_method'))
  await expect(markNeedsYouTaskSeen({ deviceId: 'phone', machine: 'Phone', local: false, phoneHost: true, session: { conversationId: 'failure' } } as never)).rejects.toThrow('unknown_method')
  expect(invokePhoneHost).toHaveBeenCalledExactlyOnceWith('phone', 'sessions.markSessionSeen', ['failure'])
  expect(markSeen).not.toHaveBeenCalled()
})

it('a month of read failures does not inflate the count; everything lists newest first', async () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
  const old = Array.from({ length: 40 }, (_, i) => failure(`old-${i}`, { unseen: false, lastInteractedAt: day(1 + (i % 28)) }))
  state.directory = { server: { cached: false, error: null, sessions: [
    ...old,
    failure('older-unread', { lastInteractedAt: day(2) }),
    { ...pending('newest-wait'), lastInteractedAt: day(30) },
    failure('newer-unread', { lastInteractedAt: day(20) }),
  ] } }
  await renderWithAppProviders(harness, <Probe />)
  expect(harness.container.querySelector('output')?.dataset.count).toBe('3')
  expect(harness.container.textContent?.split(',').slice(0, 2)).toEqual(['server:newest-wait', 'server:old-27'])
  expect(harness.container.textContent?.split(',')).toHaveLength(43)
})
