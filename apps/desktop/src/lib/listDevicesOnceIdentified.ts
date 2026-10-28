import type { Device } from '@gugu/core/shared/types/chat'
import { platform } from '../platform'
import { chatService } from './chat'
import { readOnceLocalDeviceIdentified } from './localDeviceIdentity'

/**
 * #627 The account's devices for a one-off question ("is that device online?") asked in the first seconds after start,
 * before this computer has identified itself: waits for the identification and reads then, instead of failing the action
 * that asked. The device list store keeps its own handling (it keeps the list on screen and re-reads on identification).
 */
export function listDevicesOnceIdentified(): Promise<Device[]> {
  return readOnceLocalDeviceIdentified(
    () => chatService.listDevices(),
    platform.subscribeLocalDeviceIdentified?.bind(platform),
  )
}
