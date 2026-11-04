/**
 * 乐观行:已经发出、真的那一轮还没开出来的那一句。
 *
 * 转录(ChatRoot)与对话左缘的时间线都把它当成一轮来画,所以「它长什么样」只在这里定一次 ——
 * 两处各拼一份,交接给真的那一轮时总有一处对不上(位置跳、刻度晚到)。
 */
import type { ChatAttachment, TranscriptTurn, TurnProcessItem } from '@session-chat/model';
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

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

function sourceMessageIds(text: string): string[] {
  return readDeliveryEnvelope(text)?.segments.flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId.replace(/^msg:/, '')] : []) ?? [];
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
  const waiting = incoming.filter(input => !pendingPromptLanded(input, turn ? [turn] : []));
  const active = activeTurnWithPending(turn, prompt, committed);
  if (!active) return waiting.length ? { ...pendingPromptTurn(waiting[0]!), items: waiting.flatMap(input => pendingPromptTurn(input).items) } : null;
  if (!waiting.length) return active;
  return { ...active, items: [...active.items, ...waiting.flatMap(input => pendingPromptTurn(input).items)] };
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
        : item.id === input.id || (input.id.length >= 16 && item.id.includes(input.id))
          || (ids.length ? ids.every(id => sourceIds.has(id)) : pendingPromptLanded(input, [{ ...turn, items: [item] }]));
      if (landed) match = { turnId: turn.id, itemId: item.id };
    }
    if (match) { bindings.set(`${match.turnId}\0${match.itemId}`, input); remembered?.set(input.id, match); }
    else if (!known) waiting.push(input);
  }
  if (!bindings.size) return { committed, active, waiting };
  const decorate = (turn: TranscriptTurn): TranscriptTurn => {
    const inputs = turn.items.map(item => bindings.get(`${turn.id}\0${item.id}`));
    const previous = turn === active ? undefined : cache?.get(turn);
    if (previous && previous.inputs.length === inputs.length && previous.inputs.every((input, index) => input === inputs[index])) return previous.turn;
    let changed = false;
    const items = turn.items.map((item, index) => {
      const input = inputs[index];
      if (!input?.delivery) return item;
      changed = true;
      return { ...item, sendStatus: input.delivery };
    });
    const result = changed ? { ...turn, items } : turn;
    if (turn !== active) cache?.set(turn, { inputs, turn: result, native: previous?.native });
    return result;
  };
  return { committed: committed.map(decorate), active: active ? decorate(active) : null, waiting };
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
        role: 'user',
        text: prompt.text,
        attachments: prompt.attachments,
        ...(prompt.delivery ? { sendStatus: prompt.delivery } : {}),
      } as TranscriptTurn['items'][number],
    ],
  } satisfies TranscriptTurn;
  return turn;
}
