import { pendingPromptLanded, pendingPromptNativeEcho, type PendingPrompt } from '@session-chat/state/pending-prompt'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { lifeHoldIsFailure } from '@/session/shared/core/sessions/session-life'
import { sessionInputBaseline } from './pendingSessionInput'
import { messageForUser } from './userFacingError'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'

// Existing-session human sends also use session-direct; only envelopes identify an agent delivery.
export function isTranscriptDelivery(input: Pick<LifeView['pending']['items'][number], 'kind' | 'state' | 'text'>): boolean {
  return input.kind === 'inbox-batch' || (input.kind === 'session-direct' && (input.state === 'unknown' || readDeliveryEnvelope(input.text) !== null))
}

/** The receiver's host queue and native transcript share one incoming-delivery projection on every surface. */
export function projectSessionPendingDeliveries(previous: readonly PendingPrompt[], view: LifeView | null,
  turns: readonly TranscriptTurn[], starting?: PendingPrompt['starting']): PendingPrompt[] {
  if (!view) return previous.filter(input => input.delivery?.state !== 'accepted' || (!input.nativeEcho && !pendingPromptLanded(input, turns)));
  const rows = view?.pending.items.filter(isTranscriptDelivery) ?? []
  const ids = new Set([...previous.map(input => input.id), ...rows.map(row => row.messageId)])
  return [...ids].flatMap(id => {
    const prior = previous.find(input => input.id === id)
    const row = rows.find(input => input.messageId === id)
    if (!prior && !row) return []
    const input: PendingPrompt = prior ?? { id, text: row!.text, sentAt: row!.sentAt, received: readDeliveryEnvelope(row!.text) !== null,
      hostSequence: row!.seq, baselineMessageIds: sessionInputBaseline(turns).baseline,
      afterTurnId: turns.at(-1)?.id, held: true }
    const failedStart = view !== null && lifeHoldIsFailure(view.hold) && (row?.state === 'queued' || row?.state === 'dispatching')
    const stopped = view?.hold === 'user-stop' && row?.state === 'queued'
    const delivery: NonNullable<PendingPrompt['delivery']> = row?.state === 'unknown'
      ? { state: 'unknown', retryable: false, error: row.failure ? messageForUser(row.failure) : undefined }
      : row?.state === 'failed' || failedStart
        ? { state: 'failed', retryable: failedStart, error: messageForUser(row?.failure ?? view?.failure?.message ?? '') }
        : row?.state === 'accepted' || (!row && view) ? { state: 'accepted' }
          : stopped ? { state: 'accepted' }
          : prior?.delivery?.state === 'accepted' ? prior.delivery : { state: 'sending' }
    const next = { ...input, starting, stopped, delivery, nativeEcho: pendingPromptNativeEcho(input, turns) }
    return !stopped && delivery.state === 'accepted' && next.nativeEcho ? [] : [next]
  }).sort((a, b) => (a.hostSequence ?? 0) - (b.hostSequence ?? 0))
}

/** Unknown receipts may already belong to an older page. Resolve those pages before publishing a tail bubble. */
export const PENDING_DELIVERY_HISTORY_BUDGET = { pages: 6, bytes: 768 * 1024, milliseconds: 1500 } as const

export async function loadPendingDeliveryHistory(newest: readonly TranscriptTurn[], nextCursor: number | null,
  inputs: readonly PendingPrompt[], read: (before: number) => Promise<{ turns: TranscriptTurn[]; nextCursor: number | null }>, alive: () => boolean,
  budget: { pages: number; bytes: number; milliseconds: number } = PENDING_DELIVERY_HISTORY_BUDGET) {
  const unknown = inputs.filter(input => input.delivery?.state === 'unknown')
  let turns: TranscriptTurn[] = []
  let cursor = nextCursor
  let pages = 0, bytes = 0
  let reason: 'matched' | 'end' | 'pages' | 'bytes' | 'timeout' | 'disposed' = 'matched'
  const started = Date.now()
  while (cursor !== null && alive() && unknown.some(input => !pendingPromptLanded(input, [...turns, ...newest]))) {
    if (pages >= budget.pages) { reason = 'pages'; break }
    const remaining = budget.milliseconds - (Date.now() - started)
    if (remaining <= 0) { reason = 'timeout'; break }
    const before = cursor
    let timer: ReturnType<typeof setTimeout> | undefined
    const page = await Promise.race([read(before), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining) })])
      .finally(() => clearTimeout(timer))
    pages++
    if (!alive()) { reason = 'disposed'; break }
    if (!page) { reason = 'timeout'; break }
    const size = new TextEncoder().encode(JSON.stringify(page.turns)).byteLength
    bytes += size
    if (bytes > budget.bytes) { reason = 'bytes'; break }
    turns = [...page.turns, ...turns]
    cursor = page.nextCursor
    if (cursor !== null && cursor >= before) throw new Error('Session history cursor did not advance')
  }
  if (cursor === null) reason = 'end'
  return { turns, cursor, pages, bytes, reason, milliseconds: Date.now() - started }
}
