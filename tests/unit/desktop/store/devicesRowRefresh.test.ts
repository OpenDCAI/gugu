// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { useDevicesStore } from '../../../../apps/desktop/src/store/devicesContext'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * A device's heartbeat changes its row every 30 s while a session runs, and each change is a device_changed revision.
 * Measured on beta: every one of them re-read every device row and every device project of the account (2 requests,
 * all rows). Now a revision reads only what it names: that one row, or the projects.
 */
const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  listProjects: vi.fn(),
  listener: null as null | ((operations: readonly unknown[]) => void | Promise<void>),
  seen: [] as string[][],
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: mocks.listDevices } }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: mocks.listProjects }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: (_event: string, listener: (operations: readonly unknown[]) => void) => { mocks.listener = listener; return () => undefined } }),
}))

const device = (id: string, label: string) => ({ device_id: id, label, hostname: id, platform: 'linux', status: 'online', last_seen_at: '2026-10-27T00:00:00.000Z', is_online: true, capabilities: { terminals: [], runtimes: [] }, machine_id: null, session_digest: [] })
const op = (payload: Record<string, unknown>) => ({ revision: '1', event: 'device_changed', payload: { tombstone: false, ...payload } })
function Probe() {
  const { devices } = useDevicesStore()
  mocks.seen.push(devices.map((d) => `${d.device_id}:${d.label}:${(d.projects ?? []).length}`))
  return null
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.seen = []
  mocks.listDevices.mockReset().mockResolvedValue([device('a', 'A'), device('b', 'B')])
  mocks.listProjects.mockReset().mockResolvedValue({ a: [{ local_project_id: 'p' }] })
})

async function mount() {
  const harness = createReactHarness()
  await harness.render(createNode(DevicesProvider, {}, createNode(Probe)))
  await act(async () => { await Promise.resolve() })
  mocks.listDevices.mockClear(); mocks.listProjects.mockClear()
  return harness
}

it('a device row change reads that one row and keeps the others and every project as they were', async () => {
  const harness = await mount()
  mocks.listDevices.mockResolvedValue([device('b', 'B renamed')])
  await act(async () => { await mocks.listener!([op({ device_id: 'b', kind: 'row' }), op({ device_id: 'b', kind: 'row' })]) })
  expect(mocks.listDevices).toHaveBeenCalledOnce()
  expect(mocks.listDevices).toHaveBeenCalledWith({ includePhones: true, deviceIds: ['b'] })
  expect(mocks.listProjects).not.toHaveBeenCalled()
  expect(mocks.seen.at(-1)?.sort()).toEqual(['a:A:1', 'b:B renamed:0'])
  harness.cleanup()
})

it('a projects change reads that device\'s projects only', async () => {
  const harness = await mount()
  mocks.listProjects.mockResolvedValue({ b: [{ local_project_id: 'q' }, { local_project_id: 'r' }] })
  await act(async () => { await mocks.listener!([op({ device_id: 'b', kind: 'projects' })]) })
  expect(mocks.listDevices).not.toHaveBeenCalled()
  expect(mocks.listProjects).toHaveBeenCalledExactlyOnceWith(['b'])
  expect(mocks.seen.at(-1)?.sort()).toEqual(['a:A:1', 'b:B:2'])
  harness.cleanup()
})

it('a revision without kind (written before the server tagged them) refreshes both that row and its projects', async () => {
  const harness = await mount()
  mocks.listDevices.mockResolvedValue([device('b', 'B renamed')])
  mocks.listProjects.mockResolvedValue({ b: [{ local_project_id: 'q' }] })
  await act(async () => { await mocks.listener!([op({ device_id: 'b' })]) })
  expect(mocks.listDevices).toHaveBeenCalledExactlyOnceWith({ includePhones: true, deviceIds: ['b'] })
  expect(mocks.listProjects).toHaveBeenCalledExactlyOnceWith(['b'])
  expect(mocks.seen.at(-1)?.sort()).toEqual(['a:A:1', 'b:B renamed:1'])
  harness.cleanup()
})

it('a removed device leaves the list without any read', async () => {
  const harness = await mount()
  await act(async () => { await mocks.listener!([op({ device_id: 'a', kind: 'row', tombstone: true })]) })
  expect(mocks.listDevices).not.toHaveBeenCalled()
  expect(mocks.listProjects).not.toHaveBeenCalled()
  expect(mocks.seen.at(-1)).toEqual(['b:B:0'])
  harness.cleanup()
})
