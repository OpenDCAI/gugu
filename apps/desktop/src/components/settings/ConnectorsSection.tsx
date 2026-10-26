import { useTranslation } from 'react-i18next'
import { SessionSettingsSection } from '../sessionpage/SessionSettingsSection'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { SettingsNote, SettingsPage } from './SettingsPrimitives'
import '../../i18n/registerAssistantCatalog'

/** Every application has one entry. Device grants are managed in Settings → Permissions. */
export function ConnectorsSection({ panelNavigation = false }: { panelNavigation?: boolean }) {
  const { t } = useTranslation('assistant')
  const { contact, home, identityLoading } = useAssistantHome()
  return <SettingsPage data-testid="settings-connectors">
    {home ? <SessionSettingsSection section="connectors" context={{ home, assistantName: contact?.display_name ?? t('rail'), panelNavigation }} />
      : <SettingsNote>{identityLoading ? <LoadingIndicator size="inline" /> : <span role="alert">{t('machine.identityFailed')}</span>}</SettingsNote>}
  </SettingsPage>
}
