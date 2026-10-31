import { useCallback } from 'react';
import type { QuestionAnswer } from '@gugu/session-core/session-record/contract';
import { AgentQuestionCard } from '@/components/chat/AgentQuestionCard';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionHostAsk } from './use-session-host-ask';

/**
 * An agent's question (`session_ask_user`) on its own session page — the card its private chat shows, answered through the
 * same `respond` on the machine the session runs on; whoever answers first (here, the chat, the phone) settles it. Above a
 * chat-UI session's composer, under a terminal session's terminal. Read only while the session waits on a question.
 */
export function SessionHostQuestion({
  sessionId,
  session,
}: {
  sessionId: string | null;
  session: { status: string | null; detail: string | null } | null | undefined;
}) {
  const ask = useSessionHostAsk(session?.status === 'needs_user' && session.detail === 'question' ? sessionId : null, 'agent-question');
  const respond = useCallback(
    async (answers: readonly QuestionAnswer[]) => {
      if (!sessionId || !ask) throw new Error('No question is asked here');
      const result = await rpcOn(machineRegistry.machineOf(sessionId)).sessionTimeline.sessionRespond({
        conversationId: sessionId,
        itemId: ask.itemId,
        kind: 'question',
        answers,
        by: 'desktop',
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    [sessionId, ask]
  );
  if (!sessionId || ask?.origin?.source !== 'agent-question') return null;
  return (
    <div className="px-2 pt-1" data-testid="session-host-question">
      <AgentQuestionCard key={ask.itemId} scope={sessionId} settlement={ask} respond={respond} />
    </div>
  );
}
