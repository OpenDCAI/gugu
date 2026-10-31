import type { Device } from './types/chat'

type MachineEndpoint = Pick<Device, 'device_id' | 'machine_id' | 'is_online' | 'is_current_device'> & { last_seen_at: string | null }

export type DeviceMachine<T extends MachineEndpoint = Device> = { key: string; device: T; configurations: T[]; current: boolean }

/** Configurations share hardware identity; legacy endpoints without it remain distinct. */
export function machineKeyOf(device: Pick<Device, 'machine_id' | 'device_id'>): string {
  return device.machine_id || device.device_id
}

function lastSeenTimestamp(device: MachineEndpoint): number {
  const timestamp = Date.parse(device.last_seen_at ?? '')
  return Number.isFinite(timestamp) ? timestamp : -Infinity
}

/** Keep every registered endpoint, selecting an online/recent representative without changing routing IDs. */
export function deviceMachines<T extends MachineEndpoint>(devices: readonly T[]): DeviceMachine<T>[] {
  const grouped = new Map<string, T[]>()
  for (const device of devices) {
    const key = machineKeyOf(device)
    const configurations = grouped.get(key) ?? []
    configurations.push(device)
    grouped.set(key, configurations)
  }
  return [...grouped].map(([key, configurations]) => {
    configurations.sort((a, b) => Number(b.is_online) - Number(a.is_online)
      || lastSeenTimestamp(b) - lastSeenTimestamp(a)
      || Number(b.is_current_device === true) - Number(a.is_current_device === true))
    return { key, device: configurations[0]!, configurations, current: configurations.some(device => device.is_current_device === true) }
  })
}

export function deviceMachineFor<T extends MachineEndpoint>(machines: readonly DeviceMachine<T>[], deviceId: string | null): DeviceMachine<T> | undefined {
  return machines.find(machine => machine.configurations.some(device => device.device_id === deviceId))
}

/** Group first: any online endpoint keeps the machine active; unknown dates are not old dates. */
export function partitionDeviceMachines<T extends MachineEndpoint>(machines: readonly DeviceMachine<T>[], now = Date.now()) {
  const active: DeviceMachine<T>[] = []
  const archived: DeviceMachine<T>[] = []
  for (const machine of machines) {
    const lastSeen = lastSeenTimestamp(machine.device)
    const longOffline = !machine.device.is_online && Number.isFinite(lastSeen) && now - lastSeen > 7 * 24 * 60 * 60 * 1000
    ;(longOffline ? archived : active).push(machine)
  }
  return { active, archived }
}
