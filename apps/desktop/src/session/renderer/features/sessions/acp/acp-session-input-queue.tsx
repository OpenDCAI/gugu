import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { SessionInputQueue } from '@/components/chat/SessionInputQueue';
import { confirmedSessionInputIds } from '@/lib/sessionInputOutbox';
import { useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge';
import type { AcpChatStore } from './acp-chat-store';

/** Only this projection observes transcript updates while there are sender-owned inputs. */
export const AcpSessionInputQueue = observer(function AcpSessionInputQueue({ store }: { store: Pick<AcpChatStore, 'runtimeSessionId' | 'chatState' | 'transcriptRevision'> }) {
  const pending = useQueuedSessionInputs(store.runtimeSessionId);
  const hasPending = pending.length > 0;
  const revision = hasPending ? store.transcriptRevision : 0;
  const committed = store.chatState.transcript.state.committedTurns;
  // History changes identity on seed/prepend/append; streaming only changes the active snapshot.
  const confirmedHistory = useMemo(() => hasPending ? confirmedSessionInputIds(committed) : [], [committed, hasPending]);
  const confirmed = useMemo(() => {
    if (!hasPending) return [];
    const active = store.chatState.transcript.state.activeTurnSnapshot;
    return [...confirmedHistory, ...confirmedSessionInputIds(active ? [active] : [])];
  }, [store, revision, hasPending, confirmedHistory]);
  return <SessionInputQueue sessionId={store.runtimeSessionId} confirmedClientMessageIds={confirmed} />;
});
