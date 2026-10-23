import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsNote, SettingsPage } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { nativePhoneActions } from '../phone-device/nativePhoneActions'
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
    void nativePhoneActions.deviceInfo().then((info) => {
      if (!alive) return
      if (!info.install_key?.trim()) throw new Error('无法读取这台手机的原生安装标识。')
      // Rebind a restored WebView installation to the actual native device before reading progress.
      const installId = phoneInstallId(info.install_key, info.previous_install_key)
      if (!alive) return
      try {
        const progress = readPhoneAgentSetup(ownerId, installId)
        setSetup({ ownerId, request: retry, installId, progress })
        setError(null)
        setVisible(!progress.dismissed && !progress.completed)
      } catch {
        // Corrupt presentation progress never authorizes tools. Let a deliberate next/finish save it again.
        setSetup({ ownerId, request: retry, installId, progress: { step: 'host', dismissed: false, completed: false } })
        setError('读取原有设置进度失败。可以重新选择或稍后设置，已有授权不会改变。')
        setVisible(true)
      }
    }).catch(() => {
      if (alive) { setError('读取这台手机的设置进度失败，可以重试或先使用咕咕。'); setVisible(true) }
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
    } catch {
      setError('这台手机保存不了设置进度。已选授权仍按系统和设置页为准，下次可能再次显示引导。')
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
        <Sheet onClose={dismiss} ariaLabel="设置这台手机上的 Agent" mobileFitContent testId="phone-agent-setup">
          {currentSetup ? (
            <PhoneAgentSetup
              key={`${ownerId}:${currentSetup.installId}`}
              ownerId={ownerId}
              initialStep={currentSetup.progress.completed ? 'host' : currentSetup.progress.step}
              onStep={(step) => save({ step, dismissed: false, completed: false })}
              onFinish={() => { if (save({ step: 'tools', dismissed: true, completed: true })) setVisible(false) }}
              onLater={dismiss}
              saveError={error}
            />
          ) : (
            <SettingsPage className="p-5">
              <h2 className="text-lg font-semibold">设置这台手机上的 Agent</h2>
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
