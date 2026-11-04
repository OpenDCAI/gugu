import type { TranscriptMessage, TranscriptTurn } from '../acp/client';

/** Project durable host messages into the turn that actually made the call without revising provider history. */
export function projectOwnerNotifications(turns: readonly TranscriptTurn[], activeTurn: TranscriptTurn | null, origins: ReadonlyMap<string, string> = new Map()): { turns: TranscriptTurn[]; activeTurn: TranscriptTurn | null } {
  const additions = new Map<string, TranscriptMessage[]>();
  const detached = new Set<string>();
  const targets = [...turns, ...(activeTurn ? [activeTurn] : [])];
  for (const turn of turns) {
    if (!turn.items.length || !turn.items.every(item => item.kind === 'message' && item.ownerNotification)) continue;
    for (const item of turn.items) {
      if (item.kind !== 'message' || !item.ownerNotification?.sourceTurnId) continue;
      const target = targets.find(candidate => candidate !== turn && (candidate.id === item.ownerNotification!.sourceTurnId || origins.get(candidate.id) === item.ownerNotification!.sourceTurnId));
      if (!target) continue;
      detached.add(turn.id);
      additions.set(target.id, [...(additions.get(target.id) ?? []), item]);
    }
  }
  const attach = (turn: TranscriptTurn): TranscriptTurn => {
    const extra = additions.get(turn.id);
    if (!extra?.length) return turn;
    const existing = new Set(turn.items.flatMap(item => item.kind === 'message' && item.ownerNotification ? [item.ownerNotification.requestId] : []));
    const items = [...turn.items, ...extra.filter(item => !existing.has(item.ownerNotification!.requestId))];
    // Item clocks order only the presentation inside an explicitly identified turn, never its ownership.
    const at = (item: TranscriptTurn['items'][number]) => 'at' in item && typeof item.at === 'number' ? item.at : 'startedAt' in item && typeof item.startedAt === 'number' ? item.startedAt : turn.startedAt ?? 0;
    items.sort((a, b) => at(a) - at(b));
    return { ...turn, items: items.map((item, seq) => ({ ...item, seq })) };
  };
  return { turns: turns.filter(turn => !detached.has(turn.id)).map(attach), activeTurn: activeTurn ? attach(activeTurn) : null };
}
