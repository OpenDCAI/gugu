import { useMemo } from 'react'
import { platform } from '../platform'
import { useContactsStore } from '../store/contactsContext'
import { useDevicesStore } from '../store/devicesContext'
import { assistantHomePlace, type AssistantHomePlace } from './assistantHome'
import { useMyAssistantContact } from './myAssistant'

/**
 * 全局设置里「咕咕」那几页读的:它是谁、住哪(云上 / 某台电脑)、这台电脑能不能当家。
 * 按库里的标记认(lib/myAssistant),❌ 按名字、❌ 按住在哪台:会员住云上、非会员住自己的电脑,它会搬家。
 * 这台电脑能不能当它的家只看有没有本机运行时(桌面版);网页 / 手机装不了它。
 */
export function useAssistantHome() {
  const { contacts } = useContactsStore()
  const { cloudComputer, devices } = useDevicesStore()
  const snapshot = cloudComputer?.snapshot ?? null
  const cloudDeviceId = snapshot?.deviceId ?? null
  const mine = useMyAssistantContact(contacts, cloudDeviceId)
  const contact = mine.contact
  const localDeviceId = platform.capabilities.agentRuntime ? devices.find((d) => d.is_current_device)?.device_id ?? null : null
  const home: AssistantHomePlace | null = useMemo(
    () => (contact ? assistantHomePlace(mine.homeDeviceId, devices, cloudDeviceId) : null),
    [contact, mine.homeDeviceId, devices, cloudDeviceId],
  )
  return { mine, contact, home, localDeviceId, snapshot, cloudDeviceId, cloudComputer, devices }
}
