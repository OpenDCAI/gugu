import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { platform } from '../../platform'
import { claimBackgroundWatch } from '../backgroundWatchClaims'
import { usePhoneDeviceSettings } from './phoneDeviceSettings'
import { startPhoneDevice } from './phoneDeviceRuntime'

/**
 * #7199 手机当设备:登录着、「我的 → 这台手机」的总开关开着,就让这台手机在线可被调用(登记 + 心跳 + 收调用),
 * 并挂上「后台守着」那条常驻通知 —— 切到后台照样调得到。挂在移动壳根上(与看管机器的 AgentWatchRoot 并排),
 * 切 tab 不拆;总开关关掉或退出登录就停。
 */
export function PhoneDeviceRoot(): null {
  const { t } = useTranslation('settings')
  const tRef = useRef(t)
  tRef.current = t
  const { user } = useAuth()
  const userId = user?.id ?? null
  const enabled = usePhoneDeviceSettings(userId).enabled

  useEffect(() => {
    if (!userId || !enabled || platform.kind !== 'capacitor') return
    return startPhoneDevice({
      userId,
      noticeLabel: (running) => {
        const call = running[0]
        if (!call) return tRef.current('devices.phoneActions.noticeReady')
        return tRef.current('devices.phoneActions.noticeCalling', { action: call.title })
      },
      claimNotice: (label) => claimBackgroundWatch('phoneDevice', label, tRef.current('devices.phoneActions.noticeText')),
    })
  }, [userId, enabled])

  return null
}
