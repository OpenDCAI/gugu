/**
 * #7199 owner 10-15「云电脑对用户完全不可见」+「连接要分清在哪」:
 * - 「连接应用 · 其他设备」:别的设备上每一组动作一行,能用的归已授权、登记了没开的归可用;这台自己、它住的那台、老的云设备行不在;
 * - 聊天头 / 会话列表标签不说个人助理住在哪。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return { ...actual, i18n: { ...actual.i18n, t: (key: string) => key } }
})

import type { Device } from '@gugu/core/shared/types/chat'
import { otherDeviceConnectors } from '../../../../apps/desktop/src/lib/deviceConnectors'
import { agentLocationText, resolveAgentLocation } from '../../../../apps/desktop/src/lib/agentRunningStatusModels'

type Action = { group: string; available: boolean }

function device(id: string, over: Omit<Partial<Device>, 'capabilities'> & { actions?: Action[]; capabilities?: Record<string, unknown> } = {}): Device {
  const { actions, capabilities, ...rest } = over
  return {
    device_id: id,
    label: id,
    hostname: id,
    platform: 'darwin',
    is_online: true,
    last_seen_at: '2026-10-15T07:00:00Z',
    is_current_device: false,
    machine_id: null,
    session_digest: null,
    ...rest,
    capabilities: {
      host_kind: 'desktop',
      ...capabilities,
      ...(actions
        ? { actions: { v: 1, updated_at: '2026-10-15T07:00:00Z', actions: actions.map((a, i) => ({ name: `${a.group}.${i}`, title: a.group, description: '', risk: 'low', confirm: 'never', input_schema: {}, ...a })) } }
        : {}),
    },
  } as unknown as Device
}

const pixel = device('pixel', {
  platform: 'android',
  capabilities: { host_kind: 'phone' },
  actions: [
    { group: 'calendar', available: true },
    { group: 'calendar', available: false },
    { group: 'contacts', available: false },
  ],
})

describe('连接应用 · 其他设备', () => {
  it('能用的一组归已授权,登记了没开的归可用;一组只出一行', () => {
    const { authorized, connectable } = otherDeviceConnectors([pixel], null)
    expect(authorized.map((e) => `${e.device.device_id}:${e.group}`)).toEqual(['pixel:calendar'])
    expect(connectable.map((e) => `${e.device.device_id}:${e.group}`)).toEqual(['pixel:contacts'])
  })

  it('这台自己、它住的那台(按管家给的 id 或设备行上的 cloud_computer)、老的云设备行、没登记清单的老版本都不出', () => {
    const rows = [
      device('mac', { is_current_device: true, actions: [{ group: 'calendar', available: true }] }),
      device('home', { capabilities: { host_kind: 'server' }, actions: [{ group: 'shell', available: true }] }),
      device('home2', { cloud_computer: 'asleep', capabilities: { host_kind: 'server' }, actions: [{ group: 'shell', available: true }] }),
      device('cloud:u', { platform: 'cloud', actions: [{ group: 'calendar', available: true }] }),
      device('old-linux'),
      pixel,
    ]
    const { authorized, connectable } = otherDeviceConnectors(rows, 'home')
    const ids = [...authorized, ...connectable].map((e) => e.device.device_id)
    expect(new Set(ids)).toEqual(new Set(['pixel']))
  })

  it('对照:别的电脑登记了动作就出现(判据不是「只认手机」)', () => {
    const mini = device('mini', { actions: [{ group: 'reminders', available: true }] })
    expect(otherDeviceConnectors([mini], 'home').authorized.map((e) => e.group)).toEqual(['reminders'])
  })
})

describe('聊天头 / 会话列表:不说个人助理住在哪', () => {
  const words = (key: string) => key
  it('它住的那台 = 不写位置;对照:别的机器照旧写机器名', () => {
    const devices = [device('home', { label: '云电脑', cloud_computer: 'awake' }), device('linux2', { label: 'Linux 2' })]
    expect(resolveAgentLocation('home', devices)).toBeNull()
    expect(agentLocationText(resolveAgentLocation('linux2', devices), words)).toBe('Linux 2')
  })

  it('管家说醒了、它还没上线(设备行上没有 cloud_computer)那一阵:靠它自己报的标记,照样不读机器名', () => {
    const waking = [device('home', { label: 'iZbp1c7suao1xpu5otqmh9Z', is_online: false, capabilities: { host_kind: 'server', assistant_home: true } })]
    expect(resolveAgentLocation('home', waking)).toBeNull()
  })
})
