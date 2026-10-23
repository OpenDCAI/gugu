import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useContactsStore } from '../store/contactsContext'
import { useDevicesStore } from '../store/devicesContext'

/** A Pi engine alone does not establish a phone host; only the account's known device does. */
export function useKnownPhoneAgent(agentId: string | undefined): boolean {
  const contact = useContactsStore().contacts.find((entry) => entry.id === agentId)
  const { devices, phones } = useDevicesStore()
  if (!contact?.device_id) return false
  return [...devices, ...(phones ?? [])].some((device) => device.device_id === contact.device_id && isPhoneDevice(device))
}
