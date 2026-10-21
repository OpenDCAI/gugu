// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentCreateContextBridge } from '../../../../apps/desktop/src/hooks/useAgentCreateContextBridge'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { CreateContextSnapshot } from '../../../../apps/desktop/src/lib/agentCreateContextBridge'
import type { Device } from '@gugu/core/shared/types/chat'
// @@@4287 ACP-only 装配（web/Capacitor）的设备轴此前从没被无种子地跑过：唯一的 e2e 先
const mocks = vi.hoisted(() => ({
  devices: [] as Device[],
  devicesError: null as string | null,
  readAgentCreateDefaults: vi.fn(),
  rememberAgentCreateDevice: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: mocks.devices, error: mocks.devicesError }),
}))
vi.mock('../../../../apps/desktop/src/lib/agentCreateDefaults', () => ({
  readAgentCreateDefaults: () => mocks.readAgentCreateDefaults(),
  rememberAgentCreateDevice: (id: string) => mocks.rememberAgentCreateDevice(id),
  rememberAgentCreateProject: vi.fn(),
}))
function device(overrides: Partial<Device> & { device_id: string }): Device {
  return {
    label: overrides.device_id,
    hostname: 'host',
    platform: 'darwin',
    status: 'online',
    last_seen_at: new Date().toISOString(),
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    is_online: true,
    is_current_device: false,
    ...overrides,
  } as Device
}
let harness: ReturnType<typeof createReactHarness>
let seen: CreateContextSnapshot | null = null
let seenController: ReturnType<typeof useAgentCreateContextBridge> | null = null
let consoleError: ReturnType<typeof vi.spyOn>
function Probe({ allowRemoteDevice }: { allowRemoteDevice: boolean }) {
  const controller = useAgentCreateContextBridge(true, { allowRemoteDevice })
  seen = controller.snapshot
  seenController = controller
  return null
}
async function render(allowRemoteDevice: boolean): Promise<CreateContextSnapshot> {
  await harness.render(createNode(Probe, { allowRemoteDevice }))
  await act(async () => { await Promise.resolve() })
  if (!seen) throw new Error('the probe never rendered')
  return seen
}
beforeEach(() => {
  harness = createReactHarness()
  seen = null
  seenController = null
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.devices = []
  mocks.devicesError = null
  mocks.readAgentCreateDefaults.mockResolvedValue({ deviceId: null, projectByDevice: {} })
})
afterEach(() => {
  harness.cleanup()
  consoleError.mockRestore()
})
describe('useAgentCreateContextBridge device axis', () => {
  it('asks the ACP-only shell to pick a device instead of claiming there are none', async () => {
    mocks.devices = [device({ device_id: 'desk-1', label: '书房台式机' })]
    const snapshot = await render(true)
    expect(snapshot.ready, 'positive control: defaults resolved, this is a real snapshot').toBe(true)
    expect(snapshot.devices.map((d) => d.id), 'the online device is listed in the picker').toEqual(['desk-1'])
    expect(snapshot.blockMessage).not.toContain('没有可用设备')
    expect(snapshot.blockMessage).toBe('请选择一台在线设备')
    expect(snapshot.selectedDeviceId, 'no silent auto-selection').toBeNull()
    expect(snapshot.projectsAvailable, 'the project picker stays shut until a device is chosen').toBe(false)
  })
  it('still says there is no device when the owner really has none', async () => {
    mocks.devices = []
    const snapshot = await render(true)
    expect(snapshot.devices).toEqual([])
    expect(snapshot.blockMessage, 'an empty directory keeps the literal reason').toContain('没有可用设备')
  })
  it('leaves the task-host shell alone: no local device row is still "none" there', async () => {
    mocks.devices = [device({ device_id: 'desk-1', label: '书房台式机' })]
    const snapshot = await render(false)
    expect(snapshot.blockMessage, 'the task-host contract is untouched').toContain('没有可用设备')
    expect(snapshot.selectedDeviceId).toBeNull()
  })
  it('a failed save keeps the choice in effect — the copy promises exactly that', async () => {
    mocks.devices = [device({ device_id: 'desk-1' }), device({ device_id: 'desk-2' })]
    mocks.rememberAgentCreateDevice.mockImplementation(() => Promise.reject(new Error('quota exceeded')))
    await render(true)
    if (!seenController) throw new Error('the probe never rendered')
    await act(async () => {
      (seenController as NonNullable<typeof seenController>).selectDevice('desk-2')
      await Promise.resolve()
    })
    expect(seen?.selectedDeviceId, 'the optimistic choice must survive the failed write').toBe('desk-2')
    expect(seen?.blockMessage, 'and the failure is not swallowed').toContain('没能记住')
    expect(seen?.blockMessage, 'the raw reason belongs in the log').not.toContain('quota exceeded')
    expect(consoleError, 'the raw reason must actually be in the log').toHaveBeenCalledWith(
      expect.stringContaining('[agents/create-defaults]'),
      expect.objectContaining({ err: expect.stringContaining('quota exceeded') }),
    )
  })
  it('does not shadow a real device-directory failure, and does not leak its raw text', async () => {
    mocks.devices = [device({ device_id: 'desk-1' })]
    mocks.devicesError = 'boom'
    const snapshot = await render(true)
    expect(snapshot.blockMessage, 'a load failure outranks "pick a device"').toContain('设备列表加载失败')
    expect(snapshot.blockMessage, 'the raw reason belongs in the log, not the sentence').not.toContain('boom')
  })
})
// 群成员里点的「新建 Agent」:群由壳持有,桥只把它放进快照、把「不进群」转回给壳。
describe('useAgentCreateContextBridge birth group', () => {
  function GroupProbe({ birthGroup, onClearBirthGroup }: { birthGroup: { chatId: string; name: string } | null; onClearBirthGroup: () => void }) {
    seen = useAgentCreateContextBridge(true, { allowRemoteDevice: true, birthGroup, onClearBirthGroup }).snapshot
    return null
  }
  it('carries the group into the snapshot and hands "do not join" back to the shell', async () => {
    const onClearBirthGroup = vi.fn()
    await harness.render(createNode(GroupProbe, { birthGroup: { chatId: 'chat-g', name: '产品群' }, onClearBirthGroup }))
    await act(async () => { await Promise.resolve() })
    expect(seen?.birthGroup).toEqual({ chatId: 'chat-g', name: '产品群' })
    const bridge = (window as unknown as { __GUGU_CREATE_CONTEXT__?: { getSnapshot(): CreateContextSnapshot; clearBirthGroup(): void } }).__GUGU_CREATE_CONTEXT__
    expect(bridge?.getSnapshot().birthGroup, 'the session-page side reads the same group').toEqual({ chatId: 'chat-g', name: '产品群' })
    bridge?.clearBirthGroup()
    expect(onClearBirthGroup).toHaveBeenCalledTimes(1)
  })
  it('no group = null, never a leftover', async () => {
    await harness.render(createNode(GroupProbe, { birthGroup: null, onClearBirthGroup: vi.fn() }))
    await act(async () => { await Promise.resolve() })
    expect(seen?.ready).toBe(true)
    expect(seen?.birthGroup).toBeNull()
  })
})
