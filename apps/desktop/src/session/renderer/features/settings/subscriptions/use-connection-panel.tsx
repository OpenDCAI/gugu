import { useCallback, useState } from 'react';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { SubscriptionConnections } from './SubscriptionConnections';

type Request = { agent: AgentPayload; machine: string | null; open: boolean; bounds: DOMRect };

/** Keep the task mounted: the connection menu overlays its caller and never changes its route. */
export function useConnectionPanel() {
  const [request, setRequest] = useState<Request | null>(null);
  const show = useCallback((agent: AgentPayload, machine: string | null, anchor?: HTMLElement) => {
    const origin = anchor ?? document.activeElement;
    if (!(origin instanceof HTMLElement)) throw new Error('Connection configuration requires a focused origin');
    setRequest({ agent, machine, open: true, bounds: origin.getBoundingClientRect() });
  }, []);
  const changeOpen = useCallback((open: boolean) => setRequest(value => value ? { ...value, open } : null), []);
  return {
    show,
    // Keep the closed menu mounted while its add/login dialog finishes.
    panel: request && (
      <SubscriptionConnections
        key={`${request.machine ?? 'local'}:${request.agent.id}`}
        agent={request.agent} machine={request.machine} trigger={null}
        open={request.open} onOpenChange={changeOpen}
        anchor={{ getBoundingClientRect: () => request.bounds }}
      />
    ),
  };
}
