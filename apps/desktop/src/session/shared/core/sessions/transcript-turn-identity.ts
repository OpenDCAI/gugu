import type { TranscriptTurn } from '@gugu/session-core/acp/client';

/** Keep the runtime identity when display ids are renumbered for storage. */
export function rewriteTurnId(value: string, previous: string, next: string): string {
  if (value === previous) return next;
  return value.startsWith(previous + ':') ? next + value.slice(previous.length) : value;
}

/** Change display identity only. Text and immutable referenceId remain factual history. */
export function withTranscriptTurnIdentity(turn: TranscriptTurn, nextTurnId: string, seq: number): TranscriptTurn {
  const prevTurnId = turn.id;
  if (nextTurnId === prevTurnId) return { ...turn, seq };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = (key === 'id' || key === 'parentId') && typeof val === 'string'
        ? rewriteTurnId(val, prevTurnId, nextTurnId)
        : walk(val);
    }
    return out;
  };

  return { ...(walk(turn) as TranscriptTurn), id: nextTurnId, seq };
}
