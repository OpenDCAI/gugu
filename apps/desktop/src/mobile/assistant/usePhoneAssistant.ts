import { useEffect, useMemo } from 'react'
import { useAssistantDm } from '@/components/assistant/useAssistantDm'
import { assistantHomePlace, type AssistantHomePlace } from '@/lib/assistantHome'
import { readSetupStep, writeSetupStep } from '@/lib/assistantSetupState'
import { useMyAssistantContact } from '@/lib/myAssistant'
import { useAuth } from '@/store/auth'
import { useContactsStore } from '@/store/contactsContext'
import { useDevicesStore } from '@/store/devicesContext'
import type { PhoneAssistant } from './MobileAssistantApp'
import { publishPhoneAssistant } from './phoneAssistantIdentity'
import { phoneAssistantStage, type PhoneAssistantStage } from './phoneAssistantStage'

export type { PhoneAssistantStage } from './phoneAssistantStage'

export type PhoneAssistantState = {
  /** 手机壳里有这一格:一直有(owner 10-16「没有咕咕的新用户那一格照样在」),没有它时那一格里是给它安家的引导。 */
  available: boolean
  assistant: PhoneAssistant | null
  chatId: string | null
  /** 云端宿主那台(管家给的快照;没有 = null)。设备列表里「别的设备」按它排除。 */
  cloudDeviceId: string | null
  /** 它家那台的设备 id:住云上 = 云端宿主,住人自己的电脑 = 那台电脑;还没认出它 = null。读它家里的东西都问这一台。 */
  homeDeviceId: string | null
  /** 它住哪(云上 / 哪台电脑,那台在不在线);还没认出它 = null。 */
  home: AssistantHomePlace | null
  ownerName: string | null
  stage: PhoneAssistantStage
}

/**
 * #7199 手机壳认出个人助理与和它的那条私聊(桌面由 AssistantShellHost 认、经桥给会话页;手机壳没有会话页,在这里认)。
 * 认它靠开通时的标记(lib/myAssistant.ts),❌ 按名字、❌ 按住在哪台(会员住云上、非会员住自己的电脑,它会搬家);
 * 私聊没有就建一条(与通讯录「发消息」同一个 getOrCreateDM)。只在手机壳里认(`enabled`)。
 */
export function usePhoneAssistant(enabled: boolean): PhoneAssistantState {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const { cloudComputer, devices } = useDevicesStore()
  const snapshot = enabled ? cloudComputer?.snapshot ?? null : null
  const cloudDeviceId = enabled ? snapshot?.deviceId ?? devices.find((device) => device.cloud_computer)?.device_id ?? null : null
  const mine = useMyAssistantContact(contacts)
  const contact = enabled ? mine.contact : null
  const dm = useAssistantDm(contact?.id ?? null)
  const id = contact?.id ?? null
  const name = contact?.display_name ?? null
  useEffect(() => publishPhoneAssistant(id && name ? { id, name } : null), [id, name])
  const home = useMemo(() => (contact ? assistantHomePlace(mine.homeDeviceId, devices, cloudDeviceId) : null), [contact, mine.homeDeviceId, devices, cloudDeviceId])
  // 引导在手机上走到「安家」就够了(之后的「连应用 → 一切就绪」是桌面会话页画的):认出它了就把这一步的记录清掉,❌ 留着下次还停在引导里。
  const ownerUserId = user?.id ?? null
  useEffect(() => {
    if (contact && ownerUserId && readSetupStep(ownerUserId)) writeSetupStep(ownerUserId, null)
  }, [contact, ownerUserId])
  const chatId = contact ? dm.chatId : null
  return {
    available: enabled,
    assistant: contact ? { id: contact.id, display_name: contact.display_name, avatar: contact.avatar, created_at: contact.created_at ?? null } : null,
    chatId,
    cloudDeviceId,
    homeDeviceId: contact ? home?.deviceId ?? mine.homeDeviceId ?? null : null,
    home,
    ownerName: user?.nickname ?? null,
    stage: phoneAssistantStage({
      found: !!contact,
      chatId,
      chatFailed: dm.failed,
      chatError: dm.error,
      retryChat: dm.retry,
      snapshot,
      // 管家还没问到 = 还不知道(❌ 当成「这里没开放」);问过了:没开放、有快照、没问到(有原因)都是知道了。
      // 只看管家那一份:设备列表每刷新一次都会先变成「在读」(任何一行设备变动都会刷),❌ 让已经知道的事跟着退回「在读」——
      // 那会把开通引导卸掉再挂上(#7429)。
      cloudKnown: !!cloudComputer && (!cloudComputer.available || cloudComputer.snapshot !== null || cloudComputer.loadError !== null),
      cloudLoadFailed: !!cloudComputer?.loadError,
      identity: mine,
    }),
  }
}
