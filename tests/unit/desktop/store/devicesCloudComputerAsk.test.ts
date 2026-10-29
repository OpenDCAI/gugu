// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * Every computer's heartbeat changes its row (session digest) every 30 s, and each change is a device_changed revision.
 * Only the ones that can move the cloud computer ask its manager: its own row, a computer that appears, one that is
 * removed. An owner with six or seven computers used to send one manager request per heartbeat.
 */
const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  refreshCloudComputer: vi.fn(),
  listener: null as null | ((operations: readonly unknown[]) => void | Promise<void>),
  // one object, like the real store's snapshot (useSyncExternalStore compares it by identity)
  cloudState: { available: true, snapshot: { state: 'running', deviceId: 'cloud', error: null, since: '2026-10-29T00:00:00Z' }, loadError: null, wakeRefused: null },
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: mocks.listDevices } }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: vi.fn().mockResolvedValue({}) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: (_event: string, listener: (operations: readonly unknown[]) => void) => { mocks.listener = listener; return () => undefined } }),
}))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/cloudComputerStore')>()),
  refreshCloudComputer: mocks.refreshCloudComputer,
  getCloudComputerState: () => mocks.cloudState,
}))

const device = (id: string) => ({ device_id: id, label: id, hostname: id, platform: 'linux', status: 'online', last_seen_at: '2026-10-29T00:00:00.000Z', is_online: true, capabilities: { terminals: [], runtimes: [] }, machine_id: null, session_digest: [] })
const op = (deviceId: string, tombstone = false) => ({ revision: '1', event: 'device_changed', payload: { device_id: deviceId, kind: 'row', tombstone } })

beforeEach(() => {
  window.localStorage.clear()
  mocks.listDevices.mockReset().mockResolvedValue([device('a'), device('b'), device('cloud')])
  mocks.refreshCloudComputer.mockReset().mockResolvedValue(null)
})

it('asks the cloud computer manager only for revisions that can move the cloud computer', async () => {
  const harness = createReactHarness()
  await harness.render(createNode(DevicesProvider, {}))
  await act(async () => { await Promise.resolve() })
  mocks.refreshCloudComputer.mockClear()

  mocks.listDevices.mockResolvedValue([device('a')])
  await act(async () => { await mocks.listener!([op('a'), op('b')]) })
  expect(mocks.refreshCloudComputer).not.toHaveBeenCalled()

  mocks.listDevices.mockResolvedValue([device('cloud')])
  await act(async () => { await mocks.listener!([op('cloud')]) })
  expect(mocks.refreshCloudComputer).toHaveBeenCalledTimes(1)

  mocks.listDevices.mockResolvedValue([device('new')])
  await act(async () => { await mocks.listener!([op('new')]) })
  expect(mocks.refreshCloudComputer).toHaveBeenCalledTimes(2)

  await act(async () => { await mocks.listener!([op('b', true)]) })
  expect(mocks.refreshCloudComputer).toHaveBeenCalledTimes(3)
  harness.cleanup()
})
