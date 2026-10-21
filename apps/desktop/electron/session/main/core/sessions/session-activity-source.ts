import { ReplicaState } from '@gugu/session-wire';
import { transcriptTurnSchema, type TranscriptTurn } from '@gugu/session-core/acp';
import { replySource } from '@gugu/session-core/session-record/reply-process';
import { parseConversationLink } from '@gugu/core/shared/ui/conversationLink';
import { peekAcpRuntimeClient } from '../acp/controller';

/** A host-observed current input, never a guess from cached history or the last work on a reused agent. */
export function activitySourceOf(turn: TranscriptTurn | null): string | undefined {
  if (!turn || turn.outcome || turn.endedAt !== undefined) return undefined;
  if (turn.items.filter(item => item.kind === 'message' && item.role === 'user').length !== 1) return undefined;
  const facts = replySource(turn);
  const link = facts?.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  return link?.messageId && link.messageId === facts?.messageId?.replace(/^msg:/, '').toLowerCase() ? facts?.sourceLink : undefined;
}

export async function readCurrentActivitySource(sessionId: string): Promise<string | undefined> {
  const client = await peekAcpRuntimeClient();
  if (!client) return undefined;
  const replica = new ReplicaState<TranscriptTurn | null>(client.session.state({ sessionId }, 'activeTurn'), { schema: transcriptTurnSchema.nullable() });
  try {
    await replica.ready;
    return activitySourceOf(replica.current());
  } finally { await replica.dispose(); }
}
