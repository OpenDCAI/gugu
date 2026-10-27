import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useContactsStore } from '../../store/contactsContext'
import { rendererLogger } from '../../lib/log'
import { SettingsRow } from '../settings/SettingsPrimitives'
import { Switch } from '../ui/Switch'
import './AgentPauseRow.css'

export function AgentPauseRow({ agent }: { agent: ContactUser }) {
  const { t } = useTranslation('agents')
  const { setAgentDesiredStatus } = useContactsStore()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const paused = agent.desired_status === 'offline'
  const change = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try { await setAgentDesiredStatus(agent.id, paused ? 'online' : 'offline') }
    catch (error) { rendererLogger('agents/pause').error({ error }, 'pause agent failed'); setFailed(true) }
    finally { setBusy(false) }
  }
  return <SettingsRow className="gg-agent-pause-row" data-testid="agent-profile-pause" title={t('settings.profile.pause')}
    description={failed ? <span role="alert">{t('settings.profile.pauseFailed')}</span> : t('settings.profile.pauseHint')}
    control={<Switch checked={paused} disabled={busy} aria-label={t('settings.profile.pause')} onCheckedChange={() => void change()} />} />
}
