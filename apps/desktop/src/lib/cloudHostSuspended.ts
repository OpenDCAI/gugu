import { getCloudComputerState } from './cloudComputerStore'

/** Control-plane sleep wins over the device row's delayed online heartbeat. Reads never wake it. */
export function cloudHostSuspended(deviceId: string): boolean {
  const snapshot = getCloudComputerState().snapshot
  return snapshot?.deviceId === deviceId && (snapshot.state === 'asleep' || snapshot.state === 'waking')
}
