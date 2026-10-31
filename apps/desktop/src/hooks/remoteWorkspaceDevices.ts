import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'

/** Task summaries do not grant phones a full workspace pipe or a place in workspace machine pickers. */
export function remoteWorkspaceDevices(devices: readonly Device[], { includeConfigurations = false } = {}): Device[] {
  return deviceMachines(devices)
    // Existing projects and sessions still route to their exact endpoint, including another local configuration.
    .flatMap(machine => includeConfigurations ? machine.configurations : machine.current ? [] : [machine.device])
    .filter(device => !device.device_id.startsWith('cloud:') && device.is_current_device !== true && !isPhoneDevice(device))
}
