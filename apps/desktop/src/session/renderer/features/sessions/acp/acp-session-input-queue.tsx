import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { SessionInputQueue } from '@/components/chat/SessionInputQueue';
import { confirmedSessionInputIds } from '@/lib/sessionInputOutbox';
import { useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge';
import type { AcpChatStore } from './acp-chat-store';

/** Only this projection observes transcript updates while there are sender-owned inputs. */
export const AcpSessionInputQueue = observer(function AcpSessionInputQueue({ store }: { store: AcpChatStore }) {
  const pending = useQueuedSessionInputs(store.runtimeSessionId);
  const revision = pending.length ? store.transcriptRevision : 0;
  const confirmed = useMemo(() => {
    if (!pending.length) return [];
    const transcript = store.chatState.transcript.state;
    return confirmedSessionInputIds([...transcript.committedTurns, ...(transcript.activeTurnSnapshot ? [transcript.activeTurnSnapshot] : [])]);
  }, [store, revision, pending.length]);
  return <SessionInputQueue sessionId={store.runtimeSessionId} confirmedClientMessageIds={confirmed} />;
});
