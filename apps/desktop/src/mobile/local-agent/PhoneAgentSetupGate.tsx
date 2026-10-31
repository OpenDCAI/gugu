import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsNote, SettingsPage } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { readPhoneInstallation } from '../phone-device/phoneInstallation'
import { phoneInstallId } from '../phone-device/phoneDeviceSettings'
import { phoneAgentAvailable } from './nativeAgent'
import { PhoneAgentSetup } from './PhoneAgentSetup'
import { PhoneInstallationContext } from './PhoneInstallationContext'
import { phoneAgentSetupRequest, readPhoneAgentSetup, savePhoneAgentSetup, subscribePhoneAgentSetup, type PhoneAgentSetupProgress } from './PhoneAgentSetupState'

/** Keep the app roots mounted: enabling a host in the guide must start the real native lifecycle. */
export function PhoneAgentSetupGate({ ownerId, children }: { ownerId: string; children: ReactNode }) {
  const [setup, setSetup] = useState<{ ownerId: string; request: number; installId: string; progress: PhoneAgentSetupProgress } | null>(null)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requested = useSyncExternalStore(subscribePhoneAgentSetup, () => phoneAgentSetupRequest(ownerId), () => 0)
  const handled = useRef(new Map<string, number>())
  const currentSetup = setup?.ownerId === ownerId && setup.request === retry ? setup : null

  useEffect(() => {
    if (platform.kind !== 'capacitor') return
    let alive = true
    setError(null)
    setVisible(false)
    void readPhoneInstallation(ownerId).then((info) => {
      if (!alive) return
      const installId = phoneInstallId(info.install_key ?? '', info.registration_id ?? '', info.previous_install_key)
      // Rebind a restored WebView installation to the actual native device before reading progress.
      if (!alive) return
      try {
        const progress = readPhoneAgentSetup(ownerId, installId)
        setSetup({ ownerId, request: retry, installId, progress })
        setError(null)
        setVisible(!progress.dismissed && !progress.completed)
      } catch (error) {
        rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
        // Corrupt presentation progress never authorizes tools. Let a deliberate next/finish save it again.
        setSetup({ ownerId, request: retry, installId, progress: { step: 'host', dismissed: false, completed: false } })
        setError(messageForUser(error))
        setVisible(true)
      }
    }).catch((error) => {
      rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
      if (alive) { setError(messageForUser(error)); setVisible(true) }
    })
    return () => { alive = false }
  }, [ownerId, retry])

  useEffect(() => {
    if (!requested || requested <= (handled.current.get(ownerId) ?? 0)) return
    handled.current.set(ownerId, requested)
    setError(null)
    if (currentSetup) setVisible(true)
    else setRetry((value) => value + 1)
  }, [ownerId, requested, currentSetup])

  const save = (progress: PhoneAgentSetupProgress) => {
    if (!currentSetup) return false
    try {
      savePhoneAgentSetup(ownerId, currentSetup.installId, progress)
      setSetup({ ...currentSetup, progress })
      setError(null)
      return true
    } catch (error) {
      rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
      setError(messageForUser(error))
      return false
    }
  }
  const dismiss = () => {
    if (currentSetup) save({ ...currentSetup.progress, dismissed: true })
    setVisible(false)
  }

  return (
    <PhoneInstallationContext.Provider value={currentSetup ? ownerId : null}>
      {children}
      {phoneAgentAvailable() && visible && (
        <Sheet onClose={dismiss} ariaLabel="设置这台手机上的 Agent" titleId="phone-agent-setup-heading" fullScreenMobile testId="phone-agent-setup">
          {currentSetup ? (
            <PhoneAgentSetup
              key={`${ownerId}:${currentSetup.installId}`}
              ownerId={ownerId}
              onFinish={() => { if (save({ step: 'tools', dismissed: true, completed: true })) setVisible(false) }}
              onLater={dismiss}
              saveError={error}
            />
          ) : (
            <SettingsPage className="gg-phone-setup gg-phone-setup-unavailable">
              <h2 id="phone-agent-setup-heading" className="gg-phone-setup-heading">暂时无法打开手机设置</h2>
              <SettingsNote role="alert">{error}</SettingsNote>
              <div className="flex gap-2">
                <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
                <Button variant="ghost" onClick={dismiss}>先使用咕咕</Button>
              </div>
            </SettingsPage>
          )}
        </Sheet>
      )}
    </PhoneInstallationContext.Provider>
  )
}
