import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAssistantHome } from '../lib/assistantHome'
import { readAssistantShellBridge } from '../lib/assistantShellBridge'
import { usePhoneAssistantIdentity } from '../mobile/assistant/phoneAssistantIdentity'
import { useDevicesStore } from '../store/devicesContext'

/**
 * #7199 个人助理叫什么:桌面由「助理」App 的壳认出来(assistantShellBridge),手机壳由 usePhoneAssistant 认;
 * 都还没认出 = 「个人助理」。
 */
export function useAssistantName(): string {
  const { t } = useTranslation('settings')
  const desktop = useSyncExternalStore(
    (listener) => readAssistantShellBridge()?.subscribe(listener) ?? (() => undefined),
    () => readAssistantShellBridge()?.getSnapshot()?.assistant?.display_name ?? null,
  )
  const phone = usePhoneAssistantIdentity()
  return desktop ?? phone?.name ?? t('devices.cloud.assistant')
}

/**
 * 给人看的设备表:个人助理住的那台叫它本人的名字(owner 10-15:用户看不到它住在哪;那台的 label 是「云电脑」或沙箱主机名)。
 * 只换名字,别的照旧 —— 要按设备分段 / 筛选的地方(通讯录、用量)照常能分出它那一段,只是段名说的是它。
 */
export function useDisplayDevices(devices: readonly Device[]): Device[] {
  const { cloudComputer } = useDevicesStore()
  const homeId = cloudComputer?.snapshot?.deviceId ?? null
  const name = useAssistantName()
  return useMemo(
    () => devices.map((device) => (isAssistantHome(device, homeId) && device.label !== name ? { ...device, label: name } : device)),
    [devices, homeId, name],
  )
}
