import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { createDeviceActionCaller } from '@gugu/core/cloud/deviceActionCaller'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { remoteWorkspaceDevices } from '@/hooks/remoteWorkspaceDevices'
import { directoryMachines, visibleMachines } from '@/mobile/agent-watch/machine-list'

const endpoint = (id: string, extra: Partial<Device> = {}): Device => ({
  device_id: id, machine_id: 'hardware', label: id, hostname: 'host', platform: 'linux',
  status: 'offline', is_online: false, last_seen_at: '2026-10-28T00:00:00Z',
  capabilities: { terminals: [], runtimes: [] }, ...extra,
})

describe('physical machine discovery', () => {
  const orphan = endpoint('old-configuration')
  const online = endpoint('online-configuration', { status: 'online', is_online: true, last_seen_at: '2026-10-27T00:00:00Z' })

  it('shows the same online representative in Settings, New task and phone lists regardless of row order', () => {
    for (const devices of [[orphan, online], [online, orphan]]) {
      expect(deviceMachines(devices).map(machine => machine.device.device_id)).toEqual([online.device_id])
      expect(remoteWorkspaceDevices(devices)).toEqual([online])
      expect(visibleMachines(devices, () => false)).toEqual([online])
      expect(directoryMachines(devices, () => false)).toEqual([online])
    }
  })

  it('excludes all configurations of the current machine from the remote workspace list', () => {
    const current = endpoint('local-configuration', { is_current_device: true })
    const other = endpoint('other', { machine_id: 'other-hardware' })
    expect(remoteWorkspaceDevices([current, online, other])).toEqual([other])
    expect(current.is_current_device).toBe(true)
    expect(online.is_current_device).toBeUndefined()
  })

  it('retains every remote routing endpoint when the host bridge asks for configurations', () => {
    const current = endpoint('local-configuration', { is_current_device: true })
    expect(remoteWorkspaceDevices([orphan, online], { includeConfigurations: true })).toEqual([online, orphan])
    expect(remoteWorkspaceDevices([current, online], { includeConfigurations: true })).toEqual([online])
  })

  it('groups native action discovery but keeps explicit endpoint lookup and local-call authorization', async () => {
    const devices = [orphan, online].map(device => ({
      device_id: device.device_id, machine_id: device.machine_id, label: device.label,
      online: device.is_online, last_seen_at: device.last_seen_at,
    }))
    let calls = 0
    const caller = createDeviceActionCaller({ listDevices: async () => devices, rpc: async () => { calls += 1; return { result: null } } })
    expect((await caller.describe()).map(device => device.device_id)).toEqual([online.device_id])
    expect((await caller.describe(orphan.device_id))[0]?.device_id).toBe(orphan.device_id)
    expect(await caller.call({ deviceId: online.device_id, action: 'files.read' })).toMatchObject({ ok: false, code: 'device_scope_mismatch' })
    expect(calls).toBe(0)
  })

  it('keeps distinct hardware and legacy endpoints separate in native discovery', async () => {
    const caller = createDeviceActionCaller({
      listDevices: async () => [
        { device_id: 'a', machine_id: 'one', label: 'same', online: false, last_seen_at: null },
        { device_id: 'b', machine_id: 'two', label: 'same', online: false, last_seen_at: null },
        { device_id: 'legacy-a', label: 'same', online: false, last_seen_at: null },
        { device_id: 'legacy-b', label: 'same', online: false, last_seen_at: null },
      ], rpc: async () => ({ result: null }),
    })
    expect((await caller.describe()).map(device => device.device_id)).toEqual(['a', 'b', 'legacy-a', 'legacy-b'])
  })
})
