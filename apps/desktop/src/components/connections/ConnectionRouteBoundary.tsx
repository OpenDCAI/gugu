import type { ReactNode } from 'react'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { useTranslation } from 'react-i18next'
import { useConnectionAuthority } from '@/lib/connectionBridge'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { SettingsNote,SettingsPage } from '@/components/settings/SettingsPrimitives'
import { Button } from '@/components/ui/Button'
import { connectionFailure } from './connection-copy'

/** An unavailable authority never selects a credential or account source. */
export function ConnectionRouteBoundary({ owner,legacy }: { owner(route: ConnectionRoute): ReactNode; legacy: ReactNode }) {
  const { route,error,reload } = useConnectionAuthority(),{ t } = useTranslation('connections')
  if (!route) return <SettingsPage data-testid="connection-authority-unavailable"><SettingsNote role={error ? 'alert' : 'status'}>
    {error ? connectionFailure(error,t) : <LoadingIndicator size="inline" />}
    {error ? <Button size="sm" variant="ghost" onClick={() => void reload()}>{t('retry')}</Button> : null}
  </SettingsNote></SettingsPage>
  return <div key={`${route.mode}:${route.epoch}`}>
    {route.phase === 'quiescing' || !route.acceptingNewOperations ? <SettingsNote role="status">{t('quiescing')}</SettingsNote> : null}
    <fieldset className="contents" disabled={route.phase !== 'stable' || !route.acceptingNewOperations}>
      {route.mode === 'owner' ? owner(route) : legacy}
    </fieldset>
  </div>
}
