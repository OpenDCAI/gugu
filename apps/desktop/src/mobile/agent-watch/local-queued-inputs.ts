import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { pendingPromptNativeEcho } from '@session-chat/state/pending-prompt'
import type { SessionInput } from '@/lib/sessionInputOutbox'

/** A durable local queue entry stays visible until its host queue or transcript takes over. */
export function localQueuedInputs(previous: readonly SessionInput[], sender: readonly SessionInput[],
  hosted: readonly { id: string }[], turns: readonly TranscriptTurn[]): readonly SessionInput[] {
  const inputs = new Map(previous.map(input => [input.id, input]))
  for (const input of sender) if (input.queued === true) inputs.set(input.id, { ...input,
    baseline: [...new Set([...(inputs.get(input.id)?.baseline ?? []), ...(input.baseline ?? [])])],
  })
  const hostIds = new Set(hosted.map(input => input.id))
  const claimed = new Set<string>()
  const remaining: SessionInput[] = []
  for (const input of inputs.values()) {
    // One native echo cannot take two identical inputs, including on a later render.
    const baseline = [...new Set([...(input.baseline ?? []), ...claimed])]
    const echo = pendingPromptNativeEcho({ id: input.id, text: input.text, baselineMessageIds: baseline, afterTurnId: input.afterTurnId }, turns)
    if (echo) claimed.add(echo.itemId)
    if (!hostIds.has(input.id) && !echo) remaining.push({ ...input, baseline })
  }
  return remaining
}
