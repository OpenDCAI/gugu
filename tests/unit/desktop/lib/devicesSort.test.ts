import { describe, expect, it } from 'vitest'
import { sortDevices, deviceDaysOffline, isDeviceSelectable } from '@/lib/devicesSort'
import type { Device } from '@gugu/core/shared/types/chat'
// #1749 设备列表排序/派生（面板 + selector 共享单一事实源）。
function dev(over: Partial<Device>): Device {
  return {
    device_id: over.device_id ?? 'd',
    label: over.label ?? 'Dev',
    hostname: 'h.local',
    platform: 'mac',
    status: over.is_online ? 'online' : 'offline',
    last_seen_at: over.last_seen_at ?? '2026-07-02T00:00:00.000Z',
    is_online: over.is_online ?? false,
    is_current_device: over.is_current_device ?? false,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    ...over,
  }
}
describe('sortDevices', () => {
  it('orders current → other online → offline, then by label within group', () => {
    const out = sortDevices([
      dev({ device_id: 'off-b', label: 'Zeta', is_online: false }),
      dev({ device_id: 'on-b', label: 'Bravo', is_online: true }),
      dev({ device_id: 'me', label: 'My Mac', is_online: true, is_current_device: true }),
      dev({ device_id: 'on-a', label: 'Alpha', is_online: true }),
      dev({ device_id: 'off-a', label: 'Apex', is_online: false }),
    ])
    expect(out.map((d) => d.device_id)).toEqual(['me', 'on-a', 'on-b', 'off-a', 'off-b'])
  })
  it('current device ranks first even when offline (defensive)', () => {
    const out = sortDevices([
      dev({ device_id: 'on', is_online: true }),
      dev({ device_id: 'me', is_online: false, is_current_device: true }),
    ])
    expect(out[0].device_id).toBe('me')
  })
  it('does not mutate the input array', () => {
    const input = [dev({ device_id: 'a' }), dev({ device_id: 'b' })]
    const snapshot = input.map((d) => d.device_id)
    sortDevices(input)
    expect(input.map((d) => d.device_id)).toEqual(snapshot)
  })
})
describe('deviceDaysOffline', () => {
  const now = Date.parse('2026-07-02T00:00:00.000Z')
  it.each([
    ['online', { is_online: true }, null],
    ['three days offline', { is_online: false, last_seen_at: '2026-06-29T00:00:00.000Z' }, 3],
    ['freshly offline', { is_online: false, last_seen_at: '2026-07-01T18:00:00.000Z' }, 0],
    ['invalid timestamp', { is_online: false, last_seen_at: 'not-a-date' }, null],
  ])('returns %s offline age', (_label, input, expected) => {
    expect(deviceDaysOffline(dev(input), now)).toBe(expected)
  })
})
describe('isDeviceSelectable', () => {
  it('only online devices are selectable (offline visible but disabled)', () => {
    expect(isDeviceSelectable(dev({ is_online: true }))).toBe(true)
    expect(isDeviceSelectable(dev({ is_online: false }))).toBe(false)
  })
})
