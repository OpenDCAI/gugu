// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { device } from '../../../support/testHarness'
import { writeCachedDevices } from '../../../../apps/desktop/src/store/devicesCache'
import { remoteWorkspaceDevices } from '../../../../apps/desktop/src/hooks/remoteWorkspaceDevices'

const mocks = vi.hoisted(() => ({ self: vi.fn(), cloud: vi.fn(), owner: vi.fn(), projects: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { getLocalDeviceSelfSnapshot: mocks.self } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: {}, identityDb: {}, dataClient: {}, getCurrentAuthUserId: mocks.owner,
}))
vi.mock('@gugu/core/cloud/devices', async (original) => ({
  ...await original<typeof import('@gugu/core/cloud/devices')>(), listDevices: mocks.cloud,
}))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { projects: { getProjects: mocks.projects } }, events: { on: () => () => undefined } }))
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { revalidate: vi.fn() } } }))
vi.mock('@renderer/lib/stores/view-state-cache', () => ({ viewStateCache: { get: vi.fn() } }))
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({ AcpChatStore: class {} }))
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({ AcpChatPanel: () => null }))
const { ProjectManagerStore } = await import('../../../../apps/desktop/src/session/renderer/features/projects/stores/project-manager')
const { machineRegistry } = await import('../../../../apps/desktop/src/session/renderer/lib/machine-routing')
const { chatService } = await import('../../../../apps/desktop/src/lib/chat')

beforeEach(() => {
  localStorage.clear()
  mocks.owner.mockReset().mockResolvedValue('owner')
  mocks.self.mockReset().mockResolvedValue(null)
  mocks.cloud.mockReset().mockResolvedValue([device('this-mac', []), device('other-mac', [])])
})

describe('local device identity during cold-start auth handoff', () => {
  it('does not turn this computer into a remote workspace while the live self read is undecided', async () => {
    writeCachedDevices('owner', [device('this-mac', [], { is_current_device: true })])
    const rows = await chatService.listDevices()
    expect(rows.find((row) => row.device_id === 'this-mac')?.is_current_device).toBe(true)
    expect(remoteWorkspaceDevices(rows).map((row) => row.device_id)).toEqual(['other-mac'])
  })

  it('uses cached identity without inventing online status or retaining a removed device', async () => {
    writeCachedDevices('owner', [device('this-mac', [], { is_current_device: true, is_online: true })])
    mocks.cloud.mockResolvedValue([device('this-mac', [], { is_online: false }), device('other-mac', [])])
    const rows = await chatService.listDevices()
    expect(rows.find((row) => row.device_id === 'this-mac')).toMatchObject({ is_current_device: true, is_online: false })
    mocks.cloud.mockResolvedValue([device('other-mac', [])])
    expect((await chatService.listDevices()).map((row) => row.device_id)).toEqual(['other-mac'])
  })

  it('keeps a loaded local project when the device bridge reconciles after self identity resolves', async () => {
    const project = { type: 'local' as const, id: 'local-project', name: 'Local project', path: '/local/project', baseRef: null, repositoryWorkspaceId: null, createdAt: '2026-10-27', updatedAt: '2026-10-27' }
    mocks.projects.mockResolvedValue([project])
    const store = new ProjectManagerStore()
    vi.spyOn(store, 'mountProject').mockResolvedValue(undefined)
    await store.load()
    writeCachedDevices('owner', [device('this-mac', [], { is_current_device: true })])
    const firstRemote = remoteWorkspaceDevices(await chatService.listDevices())
    for (const row of firstRemote) if (row.device_id === 'this-mac') store.syncMachineProjects(row.device_id, [project])
    mocks.self.mockResolvedValue(device('this-mac', []))
    const after = new Set(remoteWorkspaceDevices(await chatService.listDevices()).map((row) => row.device_id))
    for (const row of firstRemote) if (!after.has(row.device_id)) { store.dropMachine(row.device_id); machineRegistry.forgetMachine(row.device_id) }
    expect(store.projects.has(project.id)).toBe(true)
    expect(machineRegistry.machineOf(project.id)).toBeNull()
    store.dispose()
  })

  it('does not reuse another account’s local-device identity', async () => {
    writeCachedDevices('previous-owner', [device('this-mac', [], { is_current_device: true })])
    expect((await chatService.listDevices()).some((row) => row.is_current_device)).toBe(false)
  })

  it('prefers the live self identity', async () => {
    writeCachedDevices('owner', [device('old-mac', [], { is_current_device: true })])
    mocks.self.mockResolvedValue(device('this-mac', [], { label: 'live' }))
    const rows = await chatService.listDevices()
    expect(rows.find((row) => row.device_id === 'this-mac')?.is_current_device).toBe(true)
    expect(rows.find((row) => row.device_id === 'old-mac')).toBeUndefined()
  })
})
