import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'

/** Task summaries do not grant phones a full workspace pipe or a place in workspace machine pickers. */
export function remoteWorkspaceDevices(devices: readonly Device[]): Device[] {
  return devices.filter((device) => !device.device_id.startsWith('cloud:') && device.is_current_device !== true && !isPhoneDevice(device))
}
