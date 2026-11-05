/**
 * 乐观行:已经发出、真的那一轮还没开出来的那一句。
 *
 * 转录(ChatRoot)与对话左缘的时间线都把它当成一轮来画,所以「它长什么样」只在这里定一次 ——
 * 两处各拼一份,交接给真的那一轮时总有一处对不上(位置跳、刻度晚到)。
 */
import type { ChatAttachment, ChatItem, TranscriptTurn, TurnProcessItem } from '@session-chat/model';
import type { ToolNode } from '@gugu/session-core/acp/client';
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read';
import { deliverySourceIds as sourceMessageIds } from '@gugu/core/local/agent/deliveryIdentity';

export type PendingPrompt = {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  /**
   * 发出的时刻:这一轮唯一的计时起点。真的那一轮开出时带着同一个时刻(`PromptInput.sentAt`),交接时计时不回跳、
   * 那句话也不跳(同一天)。
   */
  sentAt?: number;
  /** A host queue row: new history (a seed while the session attaches) does not take it, only its own turn does. */
  held?: boolean;
  /** Its session is still starting (the lifecycle's own state): the live line says so instead of the working label. */
  starting?: TurnProcessItem['starting'];
  /** Ordinary sender custody, kept here until this exact input is visible in the transcript. */
  delivery?: { state: 'sending' | 'receiving' | 'waiting' | 'accepted' | 'failed' | 'unknown'; error?: string; reason?: string; retryable?: boolean };
  /** Existing user identities cannot acknowledge this input when older history is loaded. */
  baselineMessageIds?: readonly string[];
  afterTurnId?: string;
  /** Native position visible when this incoming message first appeared; streaming cannot move it. */
  position?: { turnId?: string; afterItemId?: string; withinTurn?: boolean; turnStartedAt?: number; referenceId?: string };
  /** Host-owned incoming delivery, with its original envelope and sender. */
  received?: boolean;
  hostSequence?: number;
  /** A definitive sender-side refusal is rebuilt from the outbox, never retained as a host receipt. */
  senderRejected?: boolean;
  stopped?: boolean;
  /** Once found, a receipt stays on this native message even if a later history window omits it. */
  nativeEcho?: { turnId: string; itemId: string };
};

type NativeDelivery = { item: TranscriptTurn['items'][number]; sourceIds: ReadonlySet<string> };
export type PendingMessageProjectionCache = WeakMap<TranscriptTurn, { inputs: readonly (PendingPrompt | undefined)[]; turn: TranscriptTurn; native?: readonly NativeDelivery[] }>;
const projectionEchoes = new WeakMap<PendingMessageProjectionCache, Map<string, NonNullable<PendingPrompt['nativeEcho']>>>();

export function pendingInputPosition(turn: TranscriptTurn | undefined): NonNullable<PendingPrompt['position']> {
  const last = (items: readonly ChatItem[]): ChatItem | undefined => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const leaf = item.kind === 'tool-group' ? last(item.children) : item;
      if (leaf) return leaf;
    }
  };
  return { turnId: turn?.id, afterItemId: turn ? last(turn.items)?.id : undefined, withinTurn: !!turn && !turn.outcome, turnStartedAt: turn?.startedAt, referenceId: turn?.referenceId };
}

/** Storage changes display ids, not the immutable live origin or the item suffixes. */
function positionInTurn(position: PendingPrompt['position'], turn: TranscriptTurn): PendingPrompt['position'] {
  if (!position || position.turnId === turn.id) return position;
  if (!position.turnId) return undefined;
  const original = position.turnId;
  const anchor = position.afterItemId;
  const mapped = anchor?.startsWith(original + ':') ? turn.id + anchor.slice(original.length) : anchor;
  if (position.referenceId) {
    if (turn.referenceId !== position.referenceId) return undefined;
  } else {
    // Older/replayed turns lack referenceId. Require the same session, original clock and existing
    // rewritten anchor; the caller rejects ambiguous matches rather than guessing a store sequence.
    const marker = original.lastIndexOf(':turn:');
    const session = marker < 0 ? undefined : original.slice(0, marker + 6);
    const has = (items: readonly ChatItem[]): boolean => items.some(item => item.id === mapped || (item.kind === 'tool-group' && has(item.children)));
    if (!session || !turn.id.startsWith(session) || !/^s\d+$/.test(turn.id.slice(session.length))
      || position.turnStartedAt === undefined || position.turnStartedAt !== turn.startedAt || (mapped && !has(turn.items))) return undefined;
  }
  return { ...position, turnId: turn.id, afterItemId: mapped };
}

/** A growing tool group can straddle the boundary; retain both groups and every native child id. */
function splitTools(items: readonly ToolNode[], anchor: string, suffix: string): { before: ToolNode[]; after: ToolNode[] } | undefined {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.id === anchor) return { before: items.slice(0, i + 1), after: items.slice(i + 1) };
    if (item.kind !== 'tool-group') continue;
    const split = splitTools(item.children, anchor, suffix);
    if (split) return { before: [...items.slice(0, i), { ...item, children: split.before }],
      after: [...(split.after.length ? [{ ...item, id: `${item.id}@${suffix}`, children: split.after }] : []), ...items.slice(i + 1)] };
  }
}

/** A new history seed or an unrelated active turn is not a receipt for this input. */
function findPendingPromptEcho(prompt: PendingPrompt, turns: readonly TranscriptTurn[]): PendingPrompt['nativeEcho'] {
  const deliveryIds = prompt.received ? sourceMessageIds(prompt.text) : [];
  const baseline = new Set((prompt.baselineMessageIds ?? []).map(nativeMessageKey));
  let anchor = turns.findIndex(turn => turn.id === prompt.afterTurnId);
  // Persisting a runtime turn renumbers its display prefix. Its native user identity remains the same anchor.
  if (anchor < 0 && prompt.afterTurnId !== undefined) {
    turns.forEach((turn, index) => {
      if (turn.items.some(item => item.kind === 'message' && item.role === 'user' && baseline.has(nativeMessageKey(item.id)))) anchor = index;
    });
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  let echo: PendingPrompt['nativeEcho'];
  turns.forEach((turn, index) => turn.items.forEach(item => {
    const matches = () => {
      if (item.kind !== 'message' || item.role !== 'user') return false;
      if (prompt.nativeEcho) return nativeMessageKey(item.id) === nativeMessageKey(prompt.nativeEcho.itemId);
      if (item._meta?.guguClientMessageId === prompt.id) return true;
      if (item.id === prompt.id || (prompt.id.length >= 16 && item.id.includes(prompt.id))) return true;
      if (deliveryIds.length) {
        const nativeIds = new Set(sourceMessageIds(item.text));
        if (deliveryIds.every(id => nativeIds.has(id))) return true;
      }
      if (baseline.has(nativeMessageKey(item.id))) return false;
      if (flat(item.text) !== flat(prompt.text)) return false;
      // Sender and host clocks are independent. An empty baseline anchors a first input before the first turn.
      return prompt.afterTurnId === undefined ? baseline.size === 0 : anchor >= 0 && index > anchor;
    };
    if (matches()) echo = { turnId: turn.id, itemId: item.id };
  }));
  return echo;
}

export function pendingPromptLanded(prompt: PendingPrompt, turns: readonly TranscriptTurn[]): boolean {
  return findPendingPromptEcho(prompt, turns) !== undefined;
}

export function pendingPromptNativeEcho(prompt: PendingPrompt, turns: readonly TranscriptTurn[]): PendingPrompt['nativeEcho'] {
  return prompt.nativeEcho ?? findPendingPromptEcho(prompt, turns);
}

/** Keep the input visible when a native turn starts before its user-message echo arrives. */
export function activeTurnWithPending(turn: TranscriptTurn | null, prompt: PendingPrompt | null, committed: readonly TranscriptTurn[] = []): TranscriptTurn | null {
  if (!prompt) return turn;
  if (!turn) return pendingPromptTurn(prompt);
  if (!prompt.delivery || pendingPromptLanded(prompt, [...committed, turn])) return turn;
  if (turn.items.some(item => item.kind === 'message' && item.role === 'user')) {
    return { ...turn, items: [...turn.items, ...pendingPromptTurn(prompt).items] };
  }
  return { ...turn, items: [...pendingPromptTurn(prompt).items, ...turn.items] };
}

/** Empty previous process headers must collapse when the pending row first becomes visible, not at native echo. */
export function latestVisibleTurnId(active: TranscriptTurn | null, committed: readonly TranscriptTurn[],
  prompt: PendingPrompt | null, incoming: readonly PendingPrompt[] = []): string | undefined {
  if (active) return active.id
  const pending = prompt ?? incoming.find(input => !pendingPromptLanded(input, committed))
  return pending ? `pending:${pending.id}:turn` : committed.at(-1)?.id
}

/** Incoming deliveries occupy their native position after the current turn's already visible items. */
export function activeTurnWithInputs(turn: TranscriptTurn | null, prompt: PendingPrompt | null, incoming: readonly PendingPrompt[], committed: readonly TranscriptTurn[] = []): TranscriptTurn | null {
  const waiting = incoming.filter(input => input.id !== prompt?.id && !pendingPromptLanded(input, turn ? [turn] : []));
  const active = activeTurnWithPending(turn, prompt, committed);
  if (!active) return waiting.length ? { ...pendingPromptTurn(waiting[0]!), items: waiting.flatMap(input => pendingPromptTurn(input).items) } : null;
  if (!waiting.length) return active;
  let items = [...active.items];
  const inserted = new Map<string, string>();
  for (const input of waiting) {
    const boundary = input.position && `${input.position.turnId ?? ''}\0${input.position.afterItemId ?? ''}`;
    const position = positionInTurn(input.position, active);
    const anchor = boundary !== undefined ? inserted.get(boundary) ?? position?.afterItemId : undefined;
    const offset = position ? (anchor ? items.findIndex(item => item.id === anchor) + 1 : 0) : items.length;
    const groupIndex = anchor && offset === 0 ? items.findIndex(item => item.kind === 'tool-group'
      && splitTools(item.children, anchor, input.id)) : -1;
    const group = items[groupIndex];
    if (group?.kind === 'tool-group') {
      const split = splitTools(group.children, anchor!, input.id)!;
      items = [...items.slice(0, groupIndex), { ...group, children: split.before }, ...pendingPromptTurn(input).items,
        ...(split.after.length ? [{ ...group, id: `${group.id}@${input.id}`, children: split.after }] : []), ...items.slice(groupIndex + 1)];
    } else items = [...items.slice(0, offset), ...pendingPromptTurn(input).items, ...items.slice(offset)];
    if (boundary !== undefined) inserted.set(boundary, input.id);
  }
  return { ...active, items };
}

/** A native echo can exist while its receipt is unknown. Decorate it once instead of adding a second bubble. */
export function projectPendingMessages(committed: readonly TranscriptTurn[], active: TranscriptTurn | null, incoming: readonly PendingPrompt[], cache?: PendingMessageProjectionCache): {
  committed: readonly TranscriptTurn[]; active: TranscriptTurn | null; waiting: readonly PendingPrompt[];
} {
  if (!incoming.length) return { committed, active, waiting: incoming };
  const all = [...committed, ...(active ? [active] : [])];
  const bindings = new Map<string, PendingPrompt>();
  const waiting: PendingPrompt[] = [];
  let remembered = cache ? projectionEchoes.get(cache) : undefined;
  if (cache && !remembered) { remembered = new Map(); projectionEchoes.set(cache, remembered); }
  for (const id of remembered?.keys() ?? []) if (!incoming.some(input => input.id === id)) remembered?.delete(id);
  // Committed native messages are immutable. Do not reparse their full envelopes for every streaming token.
  const native = all.map(turn => {
    const previous = turn === active ? undefined : cache?.get(turn);
    const messages = previous?.native ?? turn.items.flatMap(item => item.kind === 'message' && item.role === 'user'
      ? [{ item, sourceIds: new Set(sourceMessageIds(item.text)) }] : []);
    if (turn !== active && !previous?.native) cache?.set(turn, { inputs: [], turn, ...previous, native: messages });
    return { turn, messages };
  });
  for (const input of incoming) {
    let match: { turnId: string; itemId: string } | undefined;
    const ids = input.received ? sourceMessageIds(input.text) : [];
    const known = input.nativeEcho ?? remembered?.get(input.id) ?? (ids.length ? undefined : findPendingPromptEcho(input, all));
    for (const { turn, messages } of native) for (const { item, sourceIds } of messages) {
      const landed = known ? nativeMessageKey(item.id) === nativeMessageKey(known.itemId)
        : item._meta?.guguClientMessageId === input.id || item.id === input.id || (input.id.length >= 16 && item.id.includes(input.id))
          || (ids.length ? ids.every(id => sourceIds.has(id)) : pendingPromptLanded(input, [{ ...turn, items: [item] }]));
      if (landed) match = { turnId: turn.id, itemId: item.id };
    }
    if (match) { bindings.set(`${match.turnId}\0${match.itemId}`, input); remembered?.set(input.id, match); }
    else if (!known) waiting.push(input);
  }
  // A turn can finish before the provider echoes its injected message. Keep the same boundary
  // when it moves into the committed tier, rather than returning all its tools to the old head.
  const inserted = new Map<TranscriptTurn, PendingPrompt[]>();
  const remaining = waiting.filter(input => {
    const matches = input.position?.withinTurn ? committed.filter(turn => positionInTurn(input.position, turn)) : [];
    const target = matches.find(turn => turn.id === input.position?.turnId) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!target) return true;
    inserted.set(target, [...(inserted.get(target) ?? []), input]);
    return false;
  });
  if (!bindings.size && !inserted.size) return { committed, active, waiting };
  const decorate = (turn: TranscriptTurn): TranscriptTurn => {
    const added = inserted.get(turn) ?? [];
    const inputs = [...turn.items.map(item => bindings.get(`${turn.id}\0${item.id}`)), ...added];
    const previous = turn === active ? undefined : cache?.get(turn);
    if (previous && previous.inputs.length === inputs.length && previous.inputs.every((input, index) => input === inputs[index])) return previous.turn;
    let changed = false;
    const items = turn.items.map((item, index) => {
      const input = inputs[index];
      // A native user input is positive delivery evidence, even when its turn ended in an error.
      if (!input?.delivery || input.delivery.state === 'unknown') return item;
      changed = true;
      return { ...item, sendStatus: input.delivery };
    });
    const decorated = changed ? { ...turn, items } : turn;
    const result = added.length ? activeTurnWithInputs(decorated, null, added)! : decorated;
    if (turn !== active) cache?.set(turn, { inputs, turn: result, native: previous?.native });
    return result;
  };
  return { committed: committed.map(decorate), active: active ? decorate(active) : null, waiting: remaining };
}

/** 乐观行画成的那一轮:只有人说的那一句。 */
export function pendingPromptTurn(prompt: PendingPrompt): TranscriptTurn {
  const turn = {
    id: `pending:${prompt.id}:turn`,
    seq: 0,
    initiator: prompt.received ? 'agent' : 'user',
    ...(prompt.stopped ? { outcome: { kind: 'cancelled' as const, reason: 'cancelled' as const } } : {}),
    ...(prompt.sentAt !== undefined ? { startedAt: prompt.sentAt } : {}),
    items: [
      {
        kind: 'message',
        id: prompt.id,
        seq: 0,
        ...(prompt.sentAt !== undefined ? { at: prompt.sentAt } : {}),
        role: 'user',
        text: prompt.text,
        attachments: prompt.attachments,
        ...(prompt.delivery ? { sendStatus: prompt.delivery } : {}),
      } as TranscriptTurn['items'][number],
    ],
  } satisfies TranscriptTurn;
  return turn;
}
