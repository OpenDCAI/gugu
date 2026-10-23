import { useContext, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { platform } from '../../platform'
import { claimBackgroundWatch } from '../backgroundWatchClaims'
import { usePhoneDeviceSettings } from './phoneDeviceSettings'
import { ensurePhoneAgentHostStopped, startPhoneDevice } from './phoneDeviceRuntime'
import { rendererLogger } from '../../lib/log'
import { PhoneInstallationContext } from '../local-agent/PhoneInstallationContext'

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
  const { enabled, hostEnabled } = usePhoneDeviceSettings(userId)
  const installationOwner = useContext(PhoneInstallationContext)

  useEffect(() => {
    if (!userId || platform.kind !== 'capacitor' || installationOwner !== userId) return
    if (!enabled && !hostEnabled) {
      void ensurePhoneAgentHostStopped(userId).catch((error: unknown) => rendererLogger('phone-agent').error({ error }, 'Cannot stop a disabled phone agent host'))
      return
    }
    return startPhoneDevice({
      userId,
      hostEnabled,
      noticeLabel: (running) => {
        const call = running[0]
        if (!call) return tRef.current('devices.phoneActions.noticeReady')
        return tRef.current('devices.phoneActions.noticeCalling', { action: call.title })
      },
      claimNotice: (label) => claimBackgroundWatch('phoneDevice', label, tRef.current('devices.phoneActions.noticeText')),
    })
  }, [userId, enabled, hostEnabled, installationOwner])

  return null
}
