import { useContext, useEffect } from 'react'
import { useAuth } from '@/store/auth'
import { rendererLogger } from '@/lib/log'
import { getRendererSession } from '@/lib/sessionPublication'
import { effectiveGrants, groupGranted, readPhoneDeviceSettings, subscribePhoneDeviceSettings } from '../phone-device/phoneDeviceSettings'
import { PHONE_ACTION_GROUPS, type PhoneGroupGrants } from '../phone-device/phoneActionCatalog'
import { phoneAgentAvailable, nativeAgent } from './nativeAgent'
import { PhoneInstallationContext } from './PhoneInstallationContext'

/** Native permission mirror lives above pages: leaving the task must not revoke its tools. */
export function PhoneAgentGrants(): null {
  const { user } = useAuth()
  const ownerId = user?.id
  const installationOwner = useContext(PhoneInstallationContext)
  useEffect(() => {
    if (!ownerId || !phoneAgentAvailable() || installationOwner !== ownerId) return
    const report = (cause: unknown) => rendererLogger('phone-agent').error({ cause }, 'Cannot synchronize phone tool authorization')
    const sync = () => {
      const settings = readPhoneDeviceSettings(ownerId)
      void nativeAgent.grants({ ownerId, calendar: groupGranted(settings, 'calendar'), groups: effectiveGrants(settings) }).catch(report)
    }
    sync()
    const unsubscribe = subscribePhoneDeviceSettings(sync)
    return () => {
      unsubscribe()
      if (getRendererSession()?.user.id !== ownerId || !readPhoneDeviceSettings(ownerId).enabled) {
        const groups = Object.fromEntries(PHONE_ACTION_GROUPS.map((group) => [group, false])) as PhoneGroupGrants
        void nativeAgent.grants({ ownerId, calendar: false, groups }).catch(report)
      }
    }
  }, [ownerId, installationOwner])
  return null
}
