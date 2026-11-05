import { RadioGroup } from '@base-ui/react/radio-group'
import { Radio } from '@base-ui/react/radio'
import { ArrowLeft, Check, Monitor } from '@/lib/icons'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import type { AssistantSetupDraft } from '@/lib/assistantSetup'
import type { AssistantEngine } from '@/lib/assistantHomeIpc'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { useAgent } from '@renderer/lib/stores/use-agents'
import { useConnectionAvailability } from '@renderer/features/settings/subscriptions/use-connection-availability'
import { useConnectionPanel } from '@renderer/features/settings/subscriptions/use-connection-panel'

const engines = ['claude', 'codex'] as const
const names = { claude: 'Claude', codex: 'Codex' }

/** Local setup reads this computer, independent of the library's selected remote host. */
function useLocalEngine(engine: AssistantEngine) {
  const metadata = useAgent(engine)
  const connection = useConnectionAvailability(engine, null, metadata.data?.reading === 'not-detected')
  const state = metadata.isPending ? 'checking'
    : metadata.error || !metadata.data ? 'failed' : connection.state
  return { agent: metadata.data, state, refresh: () => Promise.all([metadata.refetch(), connection.refresh()]) }
}

/** Fixed geometry: switching engine or credentials only replaces content. */
export function AssistantEngineChoice({ engine, onEngineChange, draft, onContinue, onBack, setupFailed = false }: {
  engine: AssistantEngine
  onEngineChange: (engine: AssistantEngine) => void
  draft: AssistantSetupDraft
  onContinue: () => void
  onBack: () => void
  setupFailed?: boolean
}) {
  const { t } = useTranslation('assistant')
  const claude = useLocalEngine('claude')
  const codex = useLocalEngine('codex')
  const readings = { claude, codex }
  const selected = readings[engine]
  const connections = useConnectionPanel()
  const checking = selected.state === 'checking'
  const action = checking ? t('setup.engineChecking')
    : selected.state === 'failed' ? t('setup.engineRetry')
    : selected.state === 'usable' ? t(setupFailed ? 'setup.retry' : 'setup.continue')
    : t('setup.engineConfigure', { name: names[engine] })

  return <>
    <header className="ta-engine-header">
      <AgentAvatar name={draft.name} look={draft} id="assistant-draft" size={64} />
      <Chip><Monitor size={16} />{t('setup.homeComputerTitle')}</Chip>
      <h1 className="ta-onb-title" id="assistant-engine-title">{t('setup.engineTitle')}</h1>
    </header>
    <RadioGroup value={engine} onValueChange={value => onEngineChange(value as AssistantEngine)}
      aria-labelledby="assistant-engine-title" className="ta-engine-options" disabled={checking}>
      {engines.map(id => <Radio.Root key={id} nativeButton value={id}
        data-testid={`assistant-engine-${id}`}
        render={<Button variant="option" size="option" className="ta-engine-option">
          <AppIcon id={id} size={40} />
          <span className="ta-engine-copy"><span className="ta-engine-name">{names[id]}</span>
            {id !== engine && readings[id].state === 'unusable' && <span className="ta-engine-state">{t('setup.engineUnusable')}</span>}
          </span>
          <span className="ta-engine-mark"><Radio.Indicator><Check size={16} /></Radio.Indicator></span>
        </Button>} />)}
    </RadioGroup>
    <div className="ta-engine-actions">
      {setupFailed && selected.state === 'usable' && <p className="ta-engine-feedback" role="alert">{t('setup.failed')}</p>}
      {selected.state === 'failed' && <p className="ta-engine-feedback" role="status">{t('setup.engineReadFailed')}</p>}
      <Button variant="primary" size="xl" className="ta-engine-primary" disabled={checking}
        data-testid="assistant-engine-continue" onClick={event => {
          if (selected.state === 'usable') onContinue()
          else if (selected.state === 'failed') void selected.refresh()
          else if (selected.agent) connections.show(selected.agent, null, event.currentTarget)
        }}>{action}</Button>
    </div>
    <Button variant="ghost" size="lg" className="ta-engine-back" disabled={checking} onClick={onBack}>
      <ArrowLeft size={16} />{t('setup.back')}
    </Button>
    {connections.panel}
  </>
}
