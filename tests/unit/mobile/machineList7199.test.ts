import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { directoryMachines, visibleMachines, workspaceDevices } from '../../../apps/desktop/src/mobile/agent-watch/machine-list'
import { isAssistantHome } from '../../../apps/desktop/src/lib/assistantHome'

// #7199 手机「任务」tab 的机器列表:个人助理住的那台两种模式都不列(product spec「它住在哪」)。

const device = (id: string, extra: Partial<Device> = {}): Device => ({
  device_id: id,
  label: id,
  hostname: id,
  platform: 'darwin',
  status: 'online',
  is_online: true,
  last_seen_at: '2026-10-16T01:00:00Z',
  capabilities: {},
  machine_id: id,
  session_digest: [],
  ...extra,
} as unknown as Device)

describe('visibleMachines', () => {
  it('retains both profile directories on one physical machine', () => {
    const profiles = [device('first-profile', { machine_id: 'same-mac' }), device('second-profile', { machine_id: 'same-mac' })]
    expect(directoryMachines(profiles, () => false).map(profile => profile.device_id)).toEqual(['first-profile', 'second-profile'])
  })
  const mac = device('mac')
  const home = device('home', { cloud_computer: 'asleep' })
  const homeAwake = device('home-awake', { capabilities: { assistant_home: true } as Device['capabilities'] })

  it('云端宿主不在列:不论它此刻是休息、醒着,还是只靠心跳里的标记认出来', () => {
    const isHome = (d: Device) => isAssistantHome(d, null)
    expect(visibleMachines([mac, home, homeAwake], isHome).map((d) => d.device_id)).toEqual(['mac'])
  })
  it('按管家给的 deviceId 认(设备行上什么标记都没有时)', () => {
    const bare = device('home-bare')
    const isHome = (d: Device) => isAssistantHome(d, 'home-bare')
    expect(visibleMachines([mac, bare], isHome).map((d) => d.device_id)).toEqual(['mac'])
  })
  it('人名下只有那一台时列表是空的(不是把它顶上来)', () => {
    expect(visibleMachines([home], (d) => isAssistantHome(d, null))).toEqual([])
  })
  it('手机能跑 Agent 就是创建目标，但仍不代表支持 workspace pipe', () => {
    const phone = device('phone', { platform: 'android', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: [{ id: 'pi', available: true }] } as unknown as Device['capabilities'] })
    const devices = [phone, mac, homeAwake]
    expect(workspaceDevices(devices).map((row) => row.device_id)).toEqual(['mac', 'home-awake'])
    expect(visibleMachines(devices, (row) => isAssistantHome(row, null)).map((row) => row.device_id)).toEqual(['phone', 'mac'])
    expect(devices[0]).toBe(phone)
  })
  it('停止手机宿主后不再可创建,既有会话仍能留在同一目录', () => {
    const phone = device('phone', { platform: 'android', capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } as Device['capabilities'] })
    expect(visibleMachines([phone, mac], () => false).map((row) => row.device_id)).toEqual(['mac'])
    expect(directoryMachines([phone, mac], () => false).map((row) => row.device_id)).toEqual(['phone', 'mac'])
  })
})
