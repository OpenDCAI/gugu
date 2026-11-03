import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { pendingPromptLanded } from '@session-chat/state/pending-prompt'
import type { SessionInput } from '@/lib/sessionInputOutbox'

/** A durable local queue entry stays visible until its host queue or transcript takes over. */
export function localQueuedInputs(previous: readonly SessionInput[], sender: readonly SessionInput[],
  hosted: readonly { id: string }[], turns: readonly TranscriptTurn[]): readonly SessionInput[] {
  const inputs = new Map(previous.map(input => [input.id, input]))
  for (const input of sender) if (input.queued === true) inputs.set(input.id, input)
  const hostIds = new Set(hosted.map(input => input.id))
  return [...inputs.values()].filter(input => !hostIds.has(input.id) && !pendingPromptLanded({
    id: input.id, text: input.text, baselineMessageIds: input.baseline, afterTurnId: input.afterTurnId,
  }, turns))
}
