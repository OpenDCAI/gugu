import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { LifeView } from '@/session/shared/core/sessions/session-life'

type HostPrompt = { id: string; text: string; clientMessageId?: string; queueEdit?: { draftText: string; originalDraftText: string } }

/** A client identity means the host already received the message; it cannot become a composer draft again. */
export function phoneManualHostPrompts(prompts: readonly HostPrompt[]): HostPrompt[] {
  return prompts.filter(prompt => !prompt.clientMessageId && !readDeliveryEnvelope(prompt.text))
}

export function phoneQueuedPrompts(inputs: readonly SessionInput[]) {
  return inputs.filter(input => input.sendQueue).sort((a, b) => a.sendQueue!.order - b.sendQueue!.order)
    .map(input => ({ id: input.id, text: input.text, queueEdit: input.sendQueue!.edit }))
}

/** Save the decision with the input, before the sender may attempt any transport. */
export function phoneInputQueueIntent(working: boolean, inputs: readonly SessionInput[]): Pick<SessionInput, 'queued' | 'sendQueue'> {
  const pending = inputs.filter(input => input.admission !== 'rejected')
  const queued = working || pending.length > 0
  const previous = pending.filter(input => !input.sendQueue).sort((a, b) => b.createdAt - a.createdAt)[0]
  return { queued, ...(queued ? { sendQueue: { order: Date.now(), ...(previous ? { afterInputId: previous.id } : {}) } } : {}) }
}

/** Cached history, a pending approval and a lost connection are not permission to drain a phone's queue. */
export function phoneQueueReady(ready: boolean, phoneHost: boolean, life: Pick<LifeView, 'kind' | 'hold'> | null): boolean {
  return ready && (phoneHost || (life?.kind === 'ready' && life.hold === null))
}

export function canReleasePhoneInput(ready: boolean, working: boolean, stopping: boolean, turns: readonly TranscriptTurn[]): boolean {
  return ready && !working && !stopping && (turns.length === 0 || turns.at(-1)?.outcome?.kind === 'done')
}

/** A new owner submission may explicitly resume a stopped/failed queue; opening the page never does. */
export function canResumePhoneInput(ready: boolean, working: boolean, turns: readonly TranscriptTurn[]): boolean {
  return ready && !working && (turns.length === 0 || Boolean(turns.at(-1)?.outcome))
}

/** Phone-hosted tasks expose the same custody identity in their timeline queue instead of a desktop LifeView. */
export function phoneWaitingReceipts(prompts: readonly HostPrompt[]) {
  return prompts.flatMap((prompt, seq) => prompt.clientMessageId && !readDeliveryEnvelope(prompt.text)
    ? [{ seq, messageId: prompt.clientMessageId, text: prompt.text, preview: prompt.text, kind: 'ordinary' as const, state: 'queued' as const, failure: null }] : [])
}
