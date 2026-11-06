import type { ReactNode } from 'react'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { useConnectionAuthority } from '@/lib/connectionBridge'
import { SettingsPage } from '@/components/settings/SettingsPrimitives'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { ConnectionMutationContext } from './connection-mutation-context'

/** An unavailable authority never selects a credential or account source. */
export function ConnectionRouteBoundary({ owner,legacy }: { owner(route: ConnectionRoute): ReactNode; legacy: ReactNode }) {
  const { route } = useConnectionAuthority()
  if (!route) return <SettingsPage data-testid="connection-authority-unavailable"><AppConnectionListPlaceholder /></SettingsPage>
  return <ConnectionMutationContext value={route.phase === 'stable' && route.acceptingNewOperations} key={`${route.mode}:${route.epoch}`}>
    {route.mode === 'owner' ? owner(route) : legacy}
  </ConnectionMutationContext>
}
