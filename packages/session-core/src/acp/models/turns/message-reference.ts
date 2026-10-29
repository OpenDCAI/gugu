import type { TranscriptTurn } from './turn';

/** Exact source identity, independent of the mutable runtime/stored display prefix. */
export function messageReferenceId(turn: Pick<TranscriptTurn, 'id' | 'referenceId'>, itemId: string): string | null {
  if (turn.referenceId && itemId.startsWith(turn.id + ':')) return turn.referenceId + itemId.slice(turn.id.length);
  // Old runtimes restart their numeric turn counter. It is not a durable source.
  // Historical stored rows use :turn:sN and remain directly addressable.
  return /:turn:\d+$/.test(turn.id) ? null : itemId;
}
