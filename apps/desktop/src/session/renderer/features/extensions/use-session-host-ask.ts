import { useCallback, useEffect, useState } from 'react';
import type { ComposerPermissionRequest } from '@gugu/session-ui/react/components';
import { settlementFromWire, type AskSource, type Settlement, type SessionpageSessionEvent, type TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { sessionpageSessionTimelineChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { appInstallAskOf } from '@shared/extensions/host-actions';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { answerAppInstall, answeredTooLate, appInstallWords, sessionWaitsOnApproval } from './app-install-approval';

const pendingHostAsk = (settlements: ReadonlyMap<string, Settlement>, source: AskSource): Settlement | null =>
  [...settlements.values()].find((settlement) => settlement.origin?.source === source && settlement.state === 'pending') ?? null;

/**
 * D-31 (L11 复核 67) The ask the host keeps pending on this session's timeline — an App install it asks for the agent — for
 * the session page's band, here or for a session another desktop runs (the timeline is read on that machine). A chat-UI
 * session's own approvals stay where they are (the runtime's queue); the host's are the timeline's, for either kind.
 */
export function useSessionHostAsk(
  sessionId: string | null,
  source: AskSource
): Settlement | null {
  const [ask, setAsk] = useState<Settlement | null>(null);
  useEffect(() => {
    setAsk(null);
    if (!sessionId) return;
    let alive = true;
    const settlements = new Map<string, Settlement>();
    const take = (batch: readonly Settlement[]) => {
      for (const settlement of batch) settlements.set(settlement.itemId, settlementFromWire(settlement));
      if (alive) setAsk(pendingHostAsk(settlements, source));
    };
    const subscriptionId = crypto.randomUUID();
    const there = rpcOn(machineRegistry.machineOf(sessionId));
    // Listen first: an ask between the snapshot and the subscription must not slip past.
    const off = events.on(sessionpageSessionTimelineChannel, (event: SessionpageSessionEvent) => {
      const result = event.result as TimelineAfterResult;
      if (!result.ok) {
        settlements.clear();
        take(result.snapshot.settlements);
      } else take(result.batch.settlements);
    }, subscriptionId);
    void (async () => {
      const snapshot = await there.sessionTimeline.sessionSnapshot({ conversationId: sessionId, limit: 1 });
      if (!alive || !snapshot.ok) return;
      take(snapshot.value.settlements);
      await there.sessionTimeline.sessionSubscribe({ conversationId: sessionId, subscriptionId, cursor: snapshot.value.cursor });
    })().catch((error: unknown) =>
      log.warn('Host asks of this session could not be read', { sessionId, error: error instanceof Error ? error.message : String(error) })
    );
    return () => {
      alive = false;
      off();
      void there.sessionTimeline.sessionUnsubscribe({ subscriptionId }).catch(() => undefined);
    };
  }, [sessionId, source]);
  return ask;
}

/**
 * D-31 That ask as the session's approval band — one band, read and answered one way, on a chat-UI session's composer and
 * under a terminal session's terminal (125 10-06: whoever watches the session on the session page answers it there). Who asks
 * for what; 「不装」 answers at once, 「查看并安装」 opens this device's own sheet (naming the machine the session runs on when
 * that is another one); the answer goes to the session's `respond`, and 「已经不等了」 when the ask was withdrawn first.
 * The timeline is read only while the session waits on an approval (`session`: its status as the host wrote it) — an open
 * panel reads nothing otherwise.
 */
export function useHostAskBand(
  sessionId: string | null,
  session: { status: string | null; detail: string | null } | null | undefined
): { request: ComposerPermissionRequest; resolve: (optionId: string | null) => void } | null {
  const { translate } = useSessionMessages();
  const ask = useSessionHostAsk(sessionWaitsOnApproval(session) ? sessionId : null, 'app-install');
  const install = appInstallAskOf(ask?.origin);
  const itemId = ask?.itemId;
  const machineId = sessionId ? machineRegistry.machineOf(sessionId) : null;
  const machine = machineId ? remoteHostsStore.device(machineId)?.label ?? machineId : undefined;
  const resolve = useCallback(
    (optionId: string | null) => {
      if (!optionId || !sessionId || !itemId || !install) return;
      void answerAppInstall({
        itemId,
        ask: install,
        optionId,
        machine,
        respond: (answer) =>
          rpc.sessionTimeline.sessionRespond({ conversationId: sessionId, itemId, kind: 'permission', by: 'desktop', ...answer }),
      })
        .then((result) => {
          if (answeredTooLate(result)) toast({ title: translate('extensions.consentNoLongerWaiting') });
        })
        .catch((error: unknown) => toast({ title: error instanceof Error ? error.message : String(error), variant: 'destructive' }));
    },
    [sessionId, itemId, install, machine, translate]
  );
  if (!ask || !install) return null;
  const words = appInstallWords(install, translate, machine);
  return {
    request: {
      requestId: ask.itemId,
      title: words.title,
      statusLabel: translate('composer.awaitingApproval'),
      options: (ask.options ?? []).map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind ?? '',
        label: words.label(option.optionId),
      })),
    },
    resolve,
  };
}
