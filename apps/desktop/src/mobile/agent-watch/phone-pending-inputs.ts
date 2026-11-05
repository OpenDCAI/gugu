import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { projectSessionPendingInput, sessionInputBaseline } from '@/lib/pendingSessionInput'
import type { HostPendingRow, SessionInput } from '@/lib/sessionInputOutbox'

/** A phone can discover another client's already-sent input in the host queue before seeing its native echo. */
export function projectPhonePendingInputs(previous: readonly PendingPrompt[], sender: readonly SessionInput[],
  host: readonly HostPendingRow[], turns: readonly TranscriptTurn[]): PendingPrompt[] {
  const ordinary = host.filter(input => input.kind === 'ordinary' && !readDeliveryEnvelope(input.text))
  const ids = new Set([...previous.map(input => input.id), ...sender.filter(input => input.queued === false && !input.sendQueue).map(input => input.id),
    ...ordinary.map(input => input.messageId)])
  return [...ids].flatMap(id => {
    const receipt = ordinary.find(input => input.messageId === id)
    let prior: PendingPrompt | null = previous.find(input => input.id === id) ?? (receipt ? { id, text: receipt.text, held: true,
      baselineMessageIds: sessionInputBaseline(turns).baseline, afterTurnId: turns.at(-1)?.id,
      delivery: { state: 'sending' as const } } : null)
    const ownSender = sender.filter(input => input.id === id)
    const foreign: string[] = []
    for (const turn of turns) for (const item of turn.items) if (item.kind === 'message' && item.role === 'user') {
      const clientId = item._meta?.guguClientMessageId
      if (typeof clientId !== 'string') continue
      if (clientId === id) return []
      foreign.push(item.id)
    }
    // Two identical messages are distinct inputs: an explicitly identified echo cannot settle its neighbour.
    if (prior && foreign.length) prior = { ...prior, baselineMessageIds: [...new Set([...(prior.baselineMessageIds ?? []), ...foreign])] }
    const prompt = projectSessionPendingInput(prior, ownSender.map(input => foreign.length ? { ...input, baseline: [...new Set([...(input.baseline ?? []), ...foreign])] } : input), host, turns)
    return prompt ? [prompt] : []
  })
}
