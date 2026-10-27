import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { AgentAiModelPane } from '../agentsettings/AgentAiModelPane'
import { AssistantSection } from '../settings/AssistantSection'
import { ConnectorsSection } from '../settings/ConnectorsSection'
import { AssistantDevicesPage } from '../devices/AssistantDevicesPage'
import { Button } from '../ui/Button'
import { ChevronLeft } from '@/lib/icons'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { appState } from '../../session/renderer/lib/stores/app-state'

const SECTIONS: readonly ActiveSection[] = ['connectors', 'devices', 'channels']

/** 助理自己的设置入口；复用全局设置的数据、组件和操作，不另存一份配置。 */
export function AssistantSettingsPage({ onOpenPage, onOpenSection }: {
  onOpenPage?: (tab: 'memory' | 'tasks') => void
  onOpenSection?: (section: ActiveSection) => void
} = {}) {
  const { t } = useTranslation('assistant')
  const { contact, cloudDeviceId } = useAssistantHome()
  const [section, setSection] = useState<ActiveSection | 'aimodel' | null>(null)
  return (
    <div data-testid="assistant-settings-page">
      {section ? (
        <Button variant="ghost" onClick={() => setSection(null)}>
          <ChevronLeft size={16} />{t('setup.back')}
        </Button>
      ) : null}
      {section === 'aimodel' && contact ? <AgentAiModelPane agent={contact} />
        : section === 'connectors' ? <ConnectorsSection />
        : section === 'devices' ? <AssistantDevicesPage cloudDeviceId={cloudDeviceId} />
        : section === 'channels' ? <ConnectorsSection />
        : <AssistantSection available={SECTIONS} onOpenSection={onOpenSection ?? setSection} onOpenModel={() => setSection('aimodel')}
            onOpenAssistantPage={onOpenPage ?? ((tab) => appState.navigation.navigate('assistant', { tab }))} />}
    </div>
  )
}
