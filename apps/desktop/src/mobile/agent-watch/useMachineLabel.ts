import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'
import '@/i18n/registerMobileWorkspaceCatalog'
import type { Device } from '@gugu/core/shared/types/chat'
import { useAssistantName } from '@/hooks/useAssistantHomeLabel'
import { isAssistantHome } from '@/lib/assistantHome'
import { useDevicesStore } from '@/store/devicesContext'

type Row = Pick<Device, 'device_id' | 'cloud_computer' | 'label' | 'capabilities'>

/**
 * #7199 手机「任务」tab 上说到一台机器时叫它什么:个人助理住的那台说它本人(它的名字;还没认出 = 「个人助理」),
 * ❌ 说那台的机器名(owner 10-15「用户只知道个人助理 Agent，甚至不需要知道它生活在哪儿」)。别的机器照旧是设备名。
 */
export function useMachineLabel(): { label: (device: Row) => string; isHome: (device: Row) => boolean } {
  const { cloudComputer } = useDevicesStore()
  const ownerId = useAuth().user?.id ?? null
  const localId = ownerId ? thisPhoneDeviceId(ownerId) : null
  const { t } = useTranslation('mobileWorkspace')
  const homeId = cloudComputer?.snapshot?.deviceId ?? null
  const name = useAssistantName()
  const isHome = useCallback((device: Row) => isAssistantHome(device, homeId), [homeId])
  const label = useCallback((device: Row) => (isHome(device) ? name : device.device_id === localId ? t('thisPhone') : device.label), [isHome, name, localId, t])
  return { label, isHome }
}
