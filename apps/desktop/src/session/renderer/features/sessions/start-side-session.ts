import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { activeChatSessionId } from './view/session-pane-policy';

/**
 * Side chat forks the active provider session into an independent ACP runtime-only tab.
 * Its view id exists only in renderer/runtime memory: no conversation row, list item, or session-id
 * write. Closing the tab stops and discards the fork without mutating the source conversation.
 */
export function canStartSideSession(
  projectId: string,
  sessionId: string,
  agents?: readonly AgentPayload[]
): boolean {
  const candidate = sourceForSideSession(projectId, sessionId);
  return Boolean(
    candidate &&
    // Agent metadata is loaded asynchronously. An unresolved list is not evidence that
    // the provider lacks fork support; startSideSession performs the authoritative check.
    (agents === undefined ||
      agents.find((agent) => agent.id === candidate.source.providerId)?.capabilities.sessions.fork ===
        'supported')
  );
}

function sourceForSideSession(projectId: string, pageSessionId: string) {
  const paneLayout = getSessionView(projectId, pageSessionId)?.paneLayout;
  if (!paneLayout) return undefined;
  const sessionId = activeChatSessionId(paneLayout);
  if (!sessionId) return undefined;
  const source = sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.data;
  if (!source) return undefined;
  const forkFromProviderSessionId = source.providerSessionId ?? (source.runtime === 'pty' ? source.id : undefined);
  if (!forkFromProviderSessionId) return undefined;
  return { source, forkFromProviderSessionId };
}

/** Open a side chat and surface capability drift instead of silently creating a new session. */
export function startSideSession(projectId: string, sessionId: string): void {
  const candidate = sourceForSideSession(projectId, sessionId);
  const sessionView = getSessionView(projectId, sessionId);
  if (!candidate || !sessionView) return;
  const { source, forkFromProviderSessionId } = candidate;

  // 能不能分叉问会话所在的那台机器(别的机器上的会话,agent 装在那台机器上)。
  void rpcOn(machineRegistry.machineOf(source.id))
    .agents.get(source.providerId)
    .then((agent) => {
      if (agent?.capabilities.sessions.fork !== 'supported') {
        throw new Error(
          translateSessionMessage('chat.forkUnsupported', {
            name: agent?.name ?? source.providerId,
          })
        );
      }
      sessionView.paneLayout.open(
        'side-chat',
        {
          sessionId: source.id,
          runtimeView: {
            id: `side-chat:${crypto.randomUUID()}`,
            forkFromProviderSessionId,
            forkedFromSessionId: source.id,
          },
        },
        { preview: false, beside: true }
      );
      sessionView.setFocusedRegion('main');
    })
    .catch((error: unknown) => {
      log.error('start side chat failed', error);
      toast({
        title: translateSessionMessage('chat.sideChatFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    });
}
