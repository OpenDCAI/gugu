import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { visibleMachines } from '../../../apps/desktop/src/mobile/agent-watch/machine-list'
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
})
