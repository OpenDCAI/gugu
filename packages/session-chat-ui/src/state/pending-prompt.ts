/**
 * 乐观行:已经发出、真的那一轮还没开出来的那一句。
 *
 * 转录(ChatRoot)与对话左缘的时间线都把它当成一轮来画,所以「它长什么样」只在这里定一次 ——
 * 两处各拼一份,交接给真的那一轮时总有一处对不上(位置跳、刻度晚到)。
 */
import type { ChatAttachment, TranscriptTurn, TurnProcessItem } from '@session-chat/model';
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read';

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
  delivery?: { state: 'sending' | 'accepted' | 'failed' | 'unknown'; error?: string; retryable?: boolean };
  /** Existing user identities cannot acknowledge this input when older history is loaded. */
  baselineMessageIds?: readonly string[];
  afterTurnId?: string;
};

/** A new history seed or an unrelated active turn is not a receipt for this input. */
export function pendingPromptLanded(prompt: PendingPrompt, turns: readonly TranscriptTurn[]): boolean {
  const baseline = new Set((prompt.baselineMessageIds ?? []).map(nativeMessageKey));
  let anchor = turns.findIndex(turn => turn.id === prompt.afterTurnId);
  // Persisting a runtime turn renumbers its display prefix. Its native user identity remains the same anchor.
  if (anchor < 0 && prompt.afterTurnId !== undefined) {
    turns.forEach((turn, index) => {
      if (turn.items.some(item => item.kind === 'message' && item.role === 'user' && baseline.has(nativeMessageKey(item.id)))) anchor = index;
    });
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  return turns.some((turn, index) => turn.items.some(item => {
    if (item.kind !== 'message' || item.role !== 'user' || baseline.has(nativeMessageKey(item.id))) return false;
    if (item.id === prompt.id || (prompt.id.length >= 16 && item.id.includes(prompt.id))) return true;
    if (flat(item.text) !== flat(prompt.text)) return false;
    // Sender and host clocks are independent. An empty baseline anchors a first input before the first turn.
    return prompt.afterTurnId === undefined ? baseline.size === 0 : anchor >= 0 && index > anchor;
  }));
}

/** Keep the input visible when a native turn starts before its user-message echo arrives. */
export function activeTurnWithPending(turn: TranscriptTurn | null, prompt: PendingPrompt | null): TranscriptTurn | null {
  if (!prompt) return turn;
  if (!turn) return pendingPromptTurn(prompt);
  if (!prompt.delivery || pendingPromptLanded(prompt, [turn])) return turn;
  if (turn.items.some(item => item.kind === 'message' && item.role === 'user')) return turn;
  return { ...turn, items: [...pendingPromptTurn(prompt).items, ...turn.items] };
}

/** 乐观行画成的那一轮:只有人说的那一句。 */
export function pendingPromptTurn(prompt: PendingPrompt): TranscriptTurn {
  const turn = {
    id: `pending:${prompt.id}:turn`,
    seq: 0,
    initiator: 'user',
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
