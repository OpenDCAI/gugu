import { expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { deviceMachineFor, deviceMachines, partitionDeviceMachines } from '@gugu/core/shared/deviceMachines'

const endpoint = (id: string, extra: Partial<Device> = {}): Device => ({ device_id: id, label: 'Mac', hostname: 'mac', platform: 'darwin',
  machine_id: 'mac-hardware', tier: id, status: 'offline', is_online: false, last_seen_at: '2026-10-26T00:00:00Z',
  capabilities: { terminals: [], runtimes: [] }, ...extra })

it('groups tiers by the contacts machine key and selects the online endpoint before recency', () => {
  const olderOnline = endpoint('beta', { is_online: true, status: 'online' })
  const newerOffline = endpoint('acceptance', { last_seen_at: '2026-10-27T00:00:00Z' })
  const input = [newerOffline, olderOnline]
  const machines = deviceMachines(input)
  expect(machines).toHaveLength(1)
  expect(machines[0]!.device).toBe(olderOnline)
  expect(machines[0]!.configurations).toEqual([olderOnline, newerOffline])
  expect(input).toEqual([newerOffline, olderOnline])
  expect(deviceMachineFor(machines, 'acceptance')).toBe(machines[0])
})

it.each([false, true])('uses the most recently seen endpoint when both have online=%s', is_online => {
  const old = endpoint('old', { is_online })
  const recent = endpoint('recent', { is_online, last_seen_at: '2026-10-27T00:00:00Z' })
  expect(deviceMachines([old, recent])[0]!.device).toBe(recent)
})

it('retains the current-machine fact without changing another endpoint into the local endpoint', () => {
  const current = endpoint('current', { is_current_device: true })
  const online = endpoint('online', { is_online: true })
  const machine = deviceMachines([current, online])[0]!
  expect(machine.current).toBe(true)
  expect(machine.device).toBe(online)
  expect(machine.device.is_current_device).toBeUndefined()
})

it('keeps different hardware and legacy IDs separate even when labels match', () => {
  expect(deviceMachines([endpoint('mac'), endpoint('server', { machine_id: 'server-install' }),
    endpoint('phone', { machine_id: 'emulator-install' }), endpoint('legacy-a', { machine_id: null }),
    endpoint('legacy-b', { machine_id: null })])).toHaveLength(5)
})

it('archives after seven days, after grouping, and restores a machine when any endpoint returns', () => {
  const now = Date.parse('2026-10-27T00:00:00Z')
  const old = endpoint('old', { last_seen_at: new Date(now - 8 * 86400000).toISOString() })
  expect(partitionDeviceMachines(deviceMachines([old]), now).archived).toHaveLength(1)
  const returning = endpoint('beta', { is_online: true, last_seen_at: new Date(now).toISOString() })
  const result = partitionDeviceMachines(deviceMachines([old, returning]), now)
  expect(result.archived).toHaveLength(0)
  expect(result.active).toHaveLength(1)
  expect(result.active[0]!.configurations).toHaveLength(2)
})

it('keeps exactly seven days and unreadable timestamps in the main list', () => {
  const now = Date.parse('2026-10-27T00:00:00Z')
  for (const last_seen_at of ['2026-10-20T00:00:00Z', 'unreadable']) {
    expect(partitionDeviceMachines(deviceMachines([endpoint('a', { last_seen_at })]), now).archived).toHaveLength(0)
  }
  expect(partitionDeviceMachines(deviceMachines([endpoint('a', { last_seen_at: '2026-10-19T23:59:59.999Z' })]), now).archived).toHaveLength(1)
})

it.each(['1969-12-31T23:59:59Z', '1970-01-01T00:00:00Z'])('archives using a valid %s timestamp even alongside unknown dates', last_seen_at => {
  const known = endpoint('known', { last_seen_at })
  const unknown = endpoint('unknown', { last_seen_at: 'unreadable' })
  const machines = deviceMachines([unknown, known])
  expect(machines[0]!.device).toBe(known)
  expect(partitionDeviceMachines(machines, Date.parse('2026-10-27T00:00:00Z')).archived).toHaveLength(1)
})
