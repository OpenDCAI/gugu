import type { Device } from '@gugu/core/shared/types/chat'
import { cachedDevicesAccount, readCachedDevices } from '../store/devicesCache'
import { resolveSelfDeviceLabel } from './device-labels'

/** Preserve local identity across auth handoff without substituting stale device facts. */
export function mergeDeviceListSelf(ownerId: string, self: Device | null, cloud: readonly Device[]): Device[] {
  if (!self) {
    // Losing this identity would attach the local catalogue as a remote workspace.
    // Once self resolves, remote-hosts.forget would remove those local projects.
    const cachedSelf = cachedDevicesAccount() === ownerId
      ? readCachedDevices().find((device) => device.is_current_device === true)?.device_id
      : undefined
    return cachedSelf
      ? cloud.map((device) => ({ ...device, is_current_device: device.device_id === cachedSelf }))
      : [...cloud]
  }
  const others = cloud.filter((device) => device.device_id !== self.device_id)
  const cloudSelf = cloud.find((device) => device.device_id === self.device_id)
  const selfMerged = { ...self, label: resolveSelfDeviceLabel(self, cloudSelf?.label), machine_id: cloudSelf?.machine_id ?? null, is_current_device: true }
  return [selfMerged, ...others.map((device) => ({ ...device, is_current_device: false }))]
}
