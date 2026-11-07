import { SessionSettingsSection } from '../sessionpage/SessionSettingsSection'
import '../../i18n/registerAssistantCatalog'
import { ConnectionRouteBoundary } from '../connections/ConnectionRouteBoundary'
import { useTranslation } from 'react-i18next'
import { useAssistantHome } from '@/lib/useAssistantHome'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { SettingsNote,SettingsPage } from './SettingsPrimitives'

/** Every application has one entry. Device grants are managed in Settings → Permissions. */
export function ConnectorsSection({ panelNavigation = false,initialConnectorId }: { panelNavigation?: boolean; initialConnectorId?: string }) {
  return <ConnectionRouteBoundary owner={connectionRoute => <div data-testid="settings-connectors"><SessionSettingsSection section="connectors" context={{ panelNavigation,connectionRoute,initialConnectorId }} /></div>}
    legacy={<LegacyConnectorsSection panelNavigation={panelNavigation} />} />
}
function LegacyConnectorsSection({ panelNavigation }: { panelNavigation: boolean }) {
  const { t } = useTranslation('assistant'),{ contact,home,identityLoading } = useAssistantHome()
  return <SettingsPage data-testid="settings-connectors">
    {home ? <SessionSettingsSection section="connectors" context={{ home,assistantName: contact?.display_name ?? t('rail'),panelNavigation }} />
      : <SettingsNote>{identityLoading ? <LoadingIndicator size="inline" /> : <span role="alert">{t('machine.identityFailed')}</span>}</SettingsNote>}
  </SettingsPage>
}
