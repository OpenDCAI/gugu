import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { partitionPhones, sortAssistantDevices, sortDevices } from '../../../../apps/desktop/src/lib/devicesSort'
import { withoutAssistantHome } from '../../../../apps/desktop/src/lib/assistantHome'
import { deviceKind } from '../../../../apps/desktop/src/lib/deviceRowModel'
import { deviceAvailability, usableActionGroups } from '../../../../apps/desktop/src/lib/deviceAvailability'

// #7199 助理 App「能力 · 设备」:顺序、本机、24 小时可用 / 非全天可用、每台开了哪几项。

function device(id: string, overrides: Omit<Partial<Device>, 'capabilities'> & { capabilities?: Record<string, unknown> } = {}): Device {
  const { capabilities, ...rest } = overrides
  return {
    device_id: id,
    label: id,
    hostname: id,
    platform: 'darwin',
    is_online: true,
    last_seen_at: '2026-10-15T07:00:00Z',
    is_current_device: false,
    ...rest,
    capabilities: { host_kind: 'desktop', ...capabilities },
  } as unknown as Device
}

const phone = (id: string, overrides: Omit<Partial<Device>, 'capabilities'> = {}, actions?: Array<{ group: string; available: boolean }>) =>
  device(id, {
    platform: 'android',
    ...overrides,
    capabilities: { host_kind: 'phone', ...(actions ? { actions: { v: 1, updated_at: '', actions: actions.map((a, i) => ({ name: `${a.group}.${i}`, title: '', ...a })) } } : {}) },
  })

describe('设备页:不列它住的那台;本机 → 在线 → 离线', () => {
  const rows = [
    device('b-offline', { is_online: false }),
    device('a-online'),
    device('mac', { is_current_device: true }),
    device('cloud', { capabilities: { host_kind: 'server' } }),
    phone('pixel'),
  ]

  it('它住的那台按管家给的 deviceId 认出来、滤掉(owner 10-15 用户看不到它住在哪);「在哪跑」那份照旧本机在前', () => {
    expect(sortAssistantDevices(withoutAssistantHome(rows, 'cloud')).map((d) => d.device_id)).toEqual(['mac', 'a-online', 'pixel', 'b-offline'])
    expect(sortDevices(rows)[0]?.device_id).toBe('mac')
  })

  it('还没问到管家时,设备行上补的 cloud_computer 也认得出;两样都没有 = 一台都不滤', () => {
    const asleep = [...rows.filter((d) => d.device_id !== 'cloud'), device('cloud', { cloud_computer: 'asleep' })]
    expect(withoutAssistantHome(asleep, null).map((d) => d.device_id)).not.toContain('cloud')
    expect(withoutAssistantHome(rows, null)).toHaveLength(rows.length)
  })

  it('没有它那台时:本机在最上', () => {
    expect(sortAssistantDevices([device('x'), device('mac', { is_current_device: true })]).map((d) => d.device_id)).toEqual(['mac', 'x'])
  })
})

describe('是台什么设备、能不能随时调到', () => {
  it('云电脑 24 小时可用;手机非全天可用(一期不接推送);电脑、服务器不标', () => {
    const cloud = device('cloud', { capabilities: { host_kind: 'server' } })
    expect(deviceKind(cloud, 'cloud')).toBe('cloudComputer')
    expect(deviceAvailability('cloudComputer', cloud)).toBe('allDay')
    const pixel = phone('pixel')
    expect(deviceKind(pixel)).toBe('phone')
    expect(deviceAvailability('phone', pixel)).toBe('notAllDay')
    expect(deviceAvailability('desktop', device('mac'))).toBeNull()
    expect(deviceAvailability('server', device('box', { capabilities: { host_kind: 'server' } }))).toBeNull()
  })

  it('在手机上看:这台手机自己那一行是本机,照样标非全天可用', () => {
    const { machines, phones } = partitionPhones([device('mac'), phone('phone-me'), phone('phone-other')], 'phone-me')
    expect(machines.map((d) => d.device_id)).toEqual(['mac'])
    const me = phones.find((d) => d.device_id === 'phone-me')!
    expect(me.is_current_device).toBe(true)
    expect(deviceKind(me)).toBe('this')
    expect(deviceAvailability('this', me)).toBe('notAllDay')
    expect(phones.find((d) => d.device_id === 'phone-other')!.is_current_device).toBe(false)
  })

  it('a phone with a native agent host is a run target and appears only once', () => {
    const hosted = device('phone-me', { platform: 'android', capabilities: { host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] } })
    const { machines, phones } = partitionPhones([device('mac'), hosted, phone('action-only')], 'phone-me')
    expect(machines.map((row) => row.device_id)).toEqual(['mac', 'phone-me'])
    expect(machines[1]?.is_current_device).toBe(true)
    expect(phones.map((row) => row.device_id)).toEqual(['action-only'])
    expect([...machines, ...phones]).toHaveLength(3)
  })
})

describe('每台开了哪几项(从设备行上的动作清单读)', () => {
  it('能用的按组去重;一项都没开 = 空;没登记清单(老版本、云电脑)= null', () => {
    expect(usableActionGroups(phone('p', {}, [
      { group: 'calendar', available: true },
      { group: 'calendar', available: true },
      { group: 'location', available: true },
      { group: 'notifications', available: false },
    ]))).toEqual(['calendar', 'location'])
    expect(usableActionGroups(phone('p', {}, [{ group: 'calendar', available: false }]))).toEqual([])
    expect(usableActionGroups(device('old'))).toBeNull()
  })
})
