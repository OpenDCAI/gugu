import { useEffect } from 'react';
import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import type { AcpChatStore } from './acp-chat-store';

/** Existing session summaries announce host commits to the already-mounted conversation. */
export function useOwnerNotifications(store: AcpChatStore | null, shown: boolean) {
  const summary = useConversationSessionSummary(store?.runtimeSessionId, store ? machineRegistry.machineOf(store.runtimeSessionId) : null);
  const head = summary?.nativeOwnerNotificationSeq;
  const epoch = summary?.nativeOwnerNotificationEpoch ?? 0;
  const ready = store && !store.historyLoading && !store.reverting;
  useEffect(() => {
    if (!store || !shown || !ready || head === undefined) return;
    void store.syncOwnerNotifications(head, epoch).catch(error => log.error('Owner notification could not be loaded', { sessionId: store.sessionId, error }));
  }, [store, shown, head, epoch, ready]);
}
