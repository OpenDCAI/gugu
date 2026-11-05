import { toSerializedError } from '@gugu/session-shared/result';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { TurnSettlement } from '@shared/core/sessions/sessionEvents';

/** The notification is downstream of the write, including failures; replay is not a new live settlement. */
export async function persistWithTurnSettlement(
  input: { sessionId: string; source: string; turn: TranscriptTurn },
  write: () => Promise<void>,
  publish: (receipt: TurnSettlement) => void,
): Promise<void> {
  const referenceId = input.turn.referenceId;
  const terminal = input.source !== 'replay' && input.turn.outcome && referenceId;
  try {
    await write();
  } catch (error) {
    if (terminal) publish({ sessionId: input.sessionId, referenceId, status: 'failed',
      cause: toSerializedError(error) });
    throw error;
  }
  if (terminal) publish({ sessionId: input.sessionId, referenceId, status: 'persisted' });
}
