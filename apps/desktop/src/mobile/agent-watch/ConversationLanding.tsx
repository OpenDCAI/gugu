import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Clock } from '@/lib/icons'
import { AgentWatchScreen } from './AgentWatchChrome'
import { CreateSessionPage } from './CreateSessionPage'
import { PhoneHostSetupEntry } from './PhoneHostSetupEntry'
import './task-flow-catalog'

/** A new conversation uses the real task creation flow. Opening this page never creates an Agent. */
export function ConversationLanding({ device, onPickDevice, onHistory, onCreated, actions: extraActions }: {
  device?: Device
  actions?: ReactNode
  onPickDevice: () => void
  onHistory: () => void
  onCreated: (session: SessionpageSessionSummary, firstPrompt: string, result?: SessionpageSessionCreateResult) => void
}) {
  const { t } = useTranslation('mobileTaskFlow')
  const actions = <>
    {extraActions}
    <IconButton size="md" aria-label={t('history')} onClick={onHistory} data-testid="phone-conversation-history"><Clock /></IconButton>
  </>
  if (device) return <CreateSessionPage key={device.device_id} device={device} landing headerActions={actions} onPickHost={onPickDevice} onCreated={onCreated} />
  return (
    <AgentWatchScreen title={t('conversation')} testId="phone-conversation-unavailable" actions={actions}>
      <div className="gg-aw-conversation-empty">
        <h1 className="gg-aw-conversation-greeting">{t('greeting')}</h1>
        <p>{t('conversationHint')}</p>
        <div className="gg-aw-conversation-connect">
          <PhoneHostSetupEntry />
          <Button variant="ghost" size="lg" onClick={onPickDevice} data-testid="phone-conversation-host">{t('selectHost')}</Button>
        </div>
      </div>
    </AgentWatchScreen>
  )
}
