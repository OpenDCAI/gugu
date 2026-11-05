import { useSyncExternalStore } from 'react'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useAvatarIdentity } from '../lib/avatarIdentity'
import { directoryDevices, subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** A Pi engine alone does not establish a phone host; only the account's known device does.
 *  Every agent avatar reads this, so it selects one boolean from the identity and device directories — a device
 *  heartbeat or another contact's rename does not re-render the badge (the contacts / devices contexts would). */
export function useKnownPhoneAgent(agentId: string | undefined): boolean {
  const deviceId = useAvatarIdentity(agentId ?? '')?.device_id ?? null
  return useSyncExternalStore(subscribeDeviceSessions, () =>
    !!deviceId && directoryDevices().some((device) => device.device_id === deviceId && isPhoneDevice(device)), () => false)
}
