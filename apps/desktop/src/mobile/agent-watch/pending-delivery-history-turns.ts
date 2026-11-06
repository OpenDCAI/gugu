import type { TranscriptTurn } from '@gugu/session-core/acp/client'

/** Store seqs and the current runtime's seqs are different clocks after a restart. */
export function mergePendingDeliveryHistoryTurns(current: readonly TranscriptTurn[], extra: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
  if (!extra.length) return current
  const last = current.at(-1)
  // The caller appends the native active turn last; preserve that boundary for
  // SessionTranscriptView instead of sorting it into the committed history.
  const active = last && !last.outcome ? last : null
  const committed = active ? current.slice(0, -1) : current
  const byId = new Map([...extra, ...committed].map(turn => [turn.id, turn]))
  if (active) byId.delete(active.id)
  const history = [...byId.values()].sort((a, b) => a.seq - b.seq)
  return active ? [...history, active] : history
}
