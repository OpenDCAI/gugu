import { nativePhoneActions } from './nativePhoneActions'
import { cachedPhoneInstallation } from './phoneDeviceSettings'

export async function readPhoneInstallation(ownerId: string) {
  return nativePhoneActions.deviceInfo({ ownerId, ...cachedPhoneInstallation() })
}
