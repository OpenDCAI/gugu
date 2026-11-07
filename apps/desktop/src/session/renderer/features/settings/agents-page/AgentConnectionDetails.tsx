import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { offeredInModelPicker } from '@shared/core/agents/platform-model'
import { usePlatformModelCatalog } from '@renderer/features/sessions/session-config/platform-model-catalog'
import { SubscriptionConnections } from '../subscriptions/SubscriptionConnections'
import { useConnectionAvailability } from '../subscriptions/use-connection-availability'
import { useSessionMessages } from '@renderer/localization/use-session-messages'

export function AgentConnectionDetails({
  agent,
  machine
}: {
  agent: AgentPayload
  machine: string | null
}) {
  const { translate } = useSessionMessages()
  const { auth, state } = useConnectionAvailability(agent.id, machine, false, true)
  const platform = usePlatformModelCatalog(agent.id, 'acp')
  const hasGuguModels = platform.models.some(offeredInModelPicker)
  const description =
    auth?.kind === 'authenticated'
      ? (auth.account ?? translate('agentsPage.accountSignedIn'))
      : hasGuguModels
        ? translate('agentsPage.canUseGuguModels')
        : state === 'unusable' && platform.settled && !platform.catalogError
          ? translate('subscriptions.connections.signedOut')
          : translate('subscriptions.checking')
  return (
    <SubscriptionConnections
      agent={agent}
      machine={machine}
      settingsRows
      description={description}
    />
  )
}
