import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read'
import type { SessionInput } from '@/lib/sessionInputOutbox'

/** Native IDs may change at admission; the host carries the original client identity alongside them. */
export function hostedInputIds(hosted: readonly { id: string; clientMessageId?: string }[], turns: readonly TranscriptTurn[]): ReadonlySet<string> {
  const ids = new Set(hosted.flatMap(input => [nativeMessageKey(input.id), ...(input.clientMessageId ? [input.clientMessageId] : [])]))
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind === 'message' && item.role === 'user') {
      ids.add(nativeMessageKey(item.id))
      if (typeof item._meta?.guguClientMessageId === 'string') ids.add(item._meta.guguClientMessageId)
    }
  }
  return ids
}

/** A durable local queue entry stays visible until its host queue or transcript takes over. */
export function localQueuedInputs(previous: readonly SessionInput[], sender: readonly SessionInput[],
  hosted: readonly { id: string; clientMessageId?: string }[], turns: readonly TranscriptTurn[]): readonly SessionInput[] {
  const senderIds = new Set(sender.map(input => input.id))
  const inputs = new Map(previous.filter(input => !input.failure || senderIds.has(input.id)).map(input => [input.id, input]))
  for (const input of sender) if (input.queued === true) inputs.set(input.id, input)
  const handedOff = hostedInputIds(hosted, turns)
  // Text is not a receipt: another queued input may have exactly the same words.
  return [...inputs.values()].filter(input => !handedOff.has(nativeMessageKey(input.id)))
}
