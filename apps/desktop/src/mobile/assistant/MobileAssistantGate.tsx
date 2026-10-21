import { useTranslation } from 'react-i18next'
import { AssistantOnboarding } from '@/components/assistant/AssistantOnboarding'
import { Button } from '@/components/ui/Button'
import { PaneHeader } from '@/components/ui/Pane'
import { refreshCloudComputer } from '@/lib/cloudComputerStore'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { reloadMyAssistant } from '@/lib/myAssistant'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import type { PhoneAssistantStage } from './usePhoneAssistant'
import '@/session/renderer/features/assistant/assistant-today.css'
import './assistant-phone.css'

/**
 * #7199 底栏「咕咕」那一格还打不开和它的聊天时说哪一步(与桌面 assistant-view 同一套说法):
 * 在认它是谁(读着 / 读不到)、还没问到 / 问不到管家(如实说,❌ 当成「没有」)、
 * 它还不存在 = 给它安家的引导(与桌面同一个 AssistantOnboarding;手机上装不了它,会员一键领取、非会员引导开会员)、私聊在开 / 开不了。
 * 能打开聊天了,这一格就换成助理 App 本身。格名固定「咕咕」,还没有它时页头就写「咕咕」。
 */
export function MobileAssistantGate({ stage, name, ownerName }: { stage: Exclude<PhoneAssistantStage, { stage: 'ready' }>; name: string | null; ownerName: string | null }) {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const { cloudComputer, devices } = useDevicesStore()
  const who = name ?? t('rail')

  const body = (() => {
    switch (stage.stage) {
      case 'cloud-loading':
        return <Waiting text={t('cloud.loading')} />
      case 'cloud-unreadable':
        return (
          <>
            <p className="ta-intro-body">{t('cloud.unreadable')}</p>
            <Button variant="ghost" className="ta-pill-btn" onClick={() => void refreshCloudComputer().catch(() => undefined)} data-testid="mobile-assistant-cloud-retry">
              {t('machine.retry')}
            </Button>
          </>
        )
      case 'onboarding':
        return null
      case 'identity':
        return (
          <>
            <div className="ta-intro-glow" aria-hidden />
            <h1 className="ta-intro-title">{t('identity.title')}</h1>
            <p className="ta-intro-body">{t(`identity.${stage.state}`)}</p>
            {stage.state === 'unreadable' ? (
              <Button variant="ghost" className="ta-pill-btn" onClick={() => reloadMyAssistant(user?.id)} data-testid="mobile-assistant-identity-retry">
                {t('machine.retry')}
              </Button>
            ) : null}
          </>
        )
      case 'chat-opening':
        return <Waiting text={t('chat.opening', { name: who })} />
      case 'chat-failed':
        return (
          <>
            <p className="ta-intro-body">{t('chat.openFailed', { name: who })}</p>
            <Button variant="ghost" className="ta-pill-btn" onClick={stage.retry} data-testid="mobile-assistant-chat-retry">
              {t('machine.retry')}
            </Button>
          </>
        )
    }
  })()

  if (stage.stage === 'onboarding' && user) {
    const snapshot = stage.snapshot
    const device = snapshot?.deviceId ? devices.find((d) => d.device_id === snapshot.deviceId) ?? null : null
    return (
      <div className="ta-phone" data-testid="mobile-assistant-gate-onboarding">
        <PaneHeader mobile title={who} />
        <main className="ta-phone-gate ta-phone-onboarding">
          <AssistantOnboarding ownerUserId={user.id} ownerName={ownerName} snapshot={snapshot} device={device} cloudAvailable={!!cloudComputer?.available} localDeviceId={null} />
        </main>
      </div>
    )
  }

  return (
    <div className="ta-phone" data-testid={`mobile-assistant-gate-${stage.stage}`}>
      <PaneHeader mobile title={who} />
      <main className="ta-phone-gate">
        <div className="ta-intro">{body}</div>
      </main>
    </div>
  )
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="ta-intro-body inline-flex items-center gap-2">
      <LoadingIndicator size="inline" />
      {text}
    </p>
  )
}
