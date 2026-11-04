import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { Button } from '@/components/ui/Button';
import { SubscriptionConnections } from '../subscriptions/SubscriptionConnections';
import { useConnectionAvailability } from '../subscriptions/use-connection-availability';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function AgentConnectionDetails({ agent, machine }: { agent: AgentPayload; machine: string | null }) {
  const { translate } = useSessionMessages();
  const { state, refresh, error } = useConnectionAvailability(agent.id, machine, agent.reading === 'not-detected');
  const checking = state === 'checking';
  const statusKey = checking ? 'agentsPage.checking'
    : state === 'failed' ? 'subscriptions.payer.unknown'
    : state === 'usable' ? 'agentsPage.usable' : 'agentsPage.unusable';
  return (
    <div className="pb-6">
      <div className="flex h-16 items-start pt-4 pb-6 text-sm text-foreground-muted" role="status" title={error?.message}>
        {translate(statusKey)}
      </div>
      {checking || state === 'failed' ? (
        <Button variant="primary" size="xl" className="h-12 w-full" disabled={checking} onClick={() => void refresh()}>
          {translate(checking ? 'agentsPage.checking' : 'agentsPage.checkAgain')}
        </Button>
      ) : (
        <SubscriptionConnections agent={agent} machine={machine}
          trigger={<Button variant="primary" size="xl" className="h-12 w-full" data-testid="agent-account-configure">{translate('agentsPage.configure')}</Button>}
          label={translate('agentsPage.configure')}
        />
      )}
    </div>
  );
}
