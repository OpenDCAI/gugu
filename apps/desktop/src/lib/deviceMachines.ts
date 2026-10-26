import type { Device } from '@gugu/core/shared/types/chat'
import { machineKeyOf } from '@/components/contacts/contactsByDevice'
import { useEffect, useState } from 'react'

export type DeviceMachine = { key: string; device: Device; configurations: Device[]; current: boolean }

/** Presentation only: keep every registered endpoint, select an online/recent representative. */
export function deviceMachines(devices: readonly Device[]): DeviceMachine[] {
  const grouped = new Map<string, Device[]>()
  for (const device of devices) {
    const key = machineKeyOf(device)
    const configurations = grouped.get(key) ?? []
    configurations.push(device)
    grouped.set(key, configurations)
  }
  return [...grouped].map(([key, configurations]) => {
    configurations.sort((a, b) => Number(b.is_online) - Number(a.is_online)
      || (Date.parse(b.last_seen_at) || 0) - (Date.parse(a.last_seen_at) || 0)
      || Number(b.is_current_device === true) - Number(a.is_current_device === true))
    return { key, device: configurations[0]!, configurations, current: configurations.some(device => device.is_current_device) }
  })
}

export function deviceMachineFor(machines: readonly DeviceMachine[], deviceId: string | null): DeviceMachine | undefined {
  return machines.find(machine => machine.configurations.some(device => device.device_id === deviceId))
}

/** Group first: any online endpoint keeps the machine visible; unknown dates are not old dates. */
export function partitionDeviceMachines(machines: readonly DeviceMachine[], now = Date.now()) {
  const active: DeviceMachine[] = []
  const archived: DeviceMachine[] = []
  for (const machine of machines) {
    const lastSeen = Date.parse(machine.device.last_seen_at)
    const longOffline = !machine.device.is_online && Number.isFinite(lastSeen) && now - lastSeen > 7 * 24 * 60 * 60 * 1000
    ;(longOffline ? archived : active).push(machine)
  }
  return { active, archived }
}

/** Also age an open list across the seven-day boundary, without waiting for a heartbeat. */
export function useDeviceMachineSections(machines: readonly DeviceMachine[]) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return partitionDeviceMachines(machines, now)
}
