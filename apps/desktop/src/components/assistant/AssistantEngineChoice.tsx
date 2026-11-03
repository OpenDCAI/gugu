import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantEngine } from '../../lib/assistantHomeIpc'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { Button } from '../ui/Button'
import { AgentDetailModal } from '@/session/renderer/features/settings/agents-page/AgentDetailModal'

export function AssistantEngineChoice({ name, draftAvatar, engine, error, onChange, onContinue, onBack }: {
  name: string
  draftAvatar: string
  engine: AssistantEngine
  error: string | null
  onChange: (engine: AssistantEngine) => void
  onContinue: () => void
  onBack: () => void
}) {
  const { t } = useTranslation('assistant')
  const [configuring, setConfiguring] = useState(false)
  return <>
    <AgentAvatar name={name} avatar={draftAvatar} id="assistant-draft" size={72} />
    <h1 className="ta-onb-title">{t('setup.engineTitle')}</h1>
    <p className="ta-onb-sub">{t('setup.engineBody')}</p>
    <div className="ta-onb-chips" role="group" aria-label={t('setup.engineTitle')}>
      {(['claude', 'codex'] as const).map(value => <Button key={value} variant="option" size="lg"
        aria-pressed={engine === value} onClick={() => onChange(value)} data-testid={`assistant-setup-engine-${value}`}>
        {value === 'claude' ? 'Claude' : 'Codex'}
      </Button>)}
    </div>
    <Button variant="ghost" onClick={() => setConfiguring(true)} data-testid="assistant-setup-engine-settings">
      {t('setup.engineSettings', { engine: engine === 'claude' ? 'Claude' : 'Codex' })}
    </Button>
    {error ? <p className="ta-onb-error" role="alert" data-testid="assistant-setup-error">{t('setup.failed')}</p> : null}
    <div className="ta-onb-actions">
      <Button variant="secondary" size="lg" className="rounded-full" onClick={onBack}>{t('setup.back')}</Button>
      <Button variant="primary" size="lg" className="rounded-full" onClick={onContinue} data-testid="assistant-setup-engine-continue">{t('setup.homeComputerAction')}</Button>
    </div>
    <AgentDetailModal agentId={configuring ? engine : null} onClose={() => setConfiguring(false)} />
  </>
}
